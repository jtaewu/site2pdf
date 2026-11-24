// PoC 3: 통합 PDF 두 방식 비교
//  A) 페이지별 PDF → pdf-lib 병합 + 북마크 재구성 + 사이트 내부 URI 링크를 PDF 내부 이동(GoTo)으로 변환
//  B) 선택 페이지 본문을 하나의 HTML로 합쳐 Chrome에서 1회 인쇄(북마크·내부 링크를 Chrome이 생성)
import fs from 'node:fs';
import { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict, PDFArray } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { startFixtureServer } from './lib/server.mjs';
import { launch, safeContext, waitForStable } from './lib/browser.mjs';
import { inspectPdf } from './lib/pdfcheck.mjs';
import { renderOne, preparePage, GENERIC_PRINT_CSS } from './02-render.mjs';

const OUT = '../output/poc/pdf/merge';
const VARIANT = { css: true, fixed: 'hide', contentSelector: 'main' };

/** 소스 PDF의 북마크를 (제목, 페이지 인덱스) 목록으로 읽기 */
async function readOutline(file) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const out = [];
  const walk = async (items, depth) => {
    for (const it of items || []) {
      let dest = it.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      const pageIndex = dest ? await doc.getPageIndex(dest[0]) : 0;
      out.push({ title: it.title, depth, pageIndex });
      await walk(it.items, depth + 1);
    }
  };
  await walk(await doc.getOutline(), 0);
  await doc.destroy();
  return out;
}

/** pdf-lib로 계층 북마크 작성 */
function writeOutline(doc, tree) {
  const ctx = doc.context;
  const pages = doc.getPages();
  const build = (list, parentRef) => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((it, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parentRef, Dest: [pages[it.pageIndex].ref, 'XYZ', null, null, null] });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      if (it.children?.length) {
        const [first, last] = build(it.children, refs[i]);
        dict.set(PDFName.of('First'), first); dict.set(PDFName.of('Last'), last);
        dict.set(PDFName.of('Count'), ctx.obj(it.children.length));
      }
      ctx.assign(refs[i], dict);
    });
    return [refs[0], refs[refs.length - 1]];
  };
  const rootRef = ctx.nextRef();
  const [first, last] = build(tree, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: tree.length }));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/** 병합 문서의 URI 링크 중 포함된 페이지를 가리키는 것을 내부 이동으로 변환 */
function rewriteLinks(doc, urlToPage) {
  let rewritten = 0, external = 0;
  const pages = doc.getPages();
  for (const page of pages) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const action = a.lookup(PDFName.of('A'));
      if (!(action instanceof PDFDict)) continue;
      const uriObj = action.lookup(PDFName.of('URI'));
      if (!uriObj) continue;
      const uri = uriObj instanceof PDFString || uriObj instanceof PDFHexString ? uriObj.decodeText() : String(uriObj);
      const key = uri.split('#')[0];
      if (urlToPage.has(key)) {
        a.delete(PDFName.of('A'));
        a.set(PDFName.of('Dest'), doc.context.obj([pages[urlToPage.get(key)].ref, 'XYZ', null, null, null]));
        rewritten++;
      } else external++;
    }
  }
  return { rewritten, external };
}

async function approachA(ctx, urls, origin) {
  fs.mkdirSync(`${OUT}/a-src`, { recursive: true });
  const rendered = [];
  for (const [i, u] of urls.entries()) rendered.push(await renderOne(ctx, u, `${OUT}/a-src/${String(i + 1).padStart(3, '0')}.pdf`, VARIANT));
  const t0 = Date.now();
  const out = await PDFDocument.create();
  out.setTitle('site2pdf PoC 통합본 (A)');
  out.setCreator('site2pdf-poc');
  const tree = [], urlToPage = new Map();
  for (const r of rendered) {
    const start = out.getPageCount();
    const src = await PDFDocument.load(fs.readFileSync(r.file));
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
    urlToPage.set(r.url, start);
    const ol = await readOutline(r.file);
    // 장 제목: 첫 최상위 북마크(h1) 또는 URL
    const top = ol.filter(o => o.depth === 0);
    const chapter = { title: top[0]?.title || r.url, pageIndex: start, children: [] };
    for (const o of ol) if (!(o.depth === 0 && o === top[0])) chapter.children.push({ title: o.title, pageIndex: start + o.pageIndex });
    tree.push(chapter);
  }
  writeOutline(out, tree);
  const links = rewriteLinks(out, urlToPage);
  const file = `${OUT}/A-pdflib-merged.pdf`;
  fs.writeFileSync(file, await out.save());
  const info = await inspectPdf(file);
  return { file, mergeMs: Date.now() - t0, pages: info.pages, outline: info.outline, links: info.links, rewrite: links, sizeKB: Math.round(fs.statSync(file).size / 1024), pageMap: [...urlToPage].map(([u, p]) => `${p + 1}p ← ${u.replace(origin, '')}`) };
}

async function approachB(ctx, urls, origin) {
  const t0 = Date.now();
  const sections = [];
  const styles = new Set();
  const page = await ctx.newPage();
  for (const [n, u] of urls.entries()) {
    await page.goto(u, { waitUntil: 'commit' });
    await waitForStable(page, { timeoutMs: 6000 });
    const r = await page.evaluate(({ n, sel, included }) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const css = [...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.href);
      // id 충돌 방지 접두사, 자산/링크 절대경로화, 포함 페이지 링크는 문서 내부 앵커로
      el.querySelectorAll('[id]').forEach(x => { x.id = `p${n}-${x.id}`; });
      el.querySelectorAll('img[src]').forEach(x => x.setAttribute('src', x.src));
      el.querySelectorAll('a[href]').forEach(a => {
        const abs = a.href; const [base, hash] = abs.split('#');
        const idx = included.indexOf(base);
        a.setAttribute('href', idx >= 0 ? (hash ? `#p${idx}-${hash}` : `#p${idx}`) : abs);
      });
      return { html: el.innerHTML, css };
    }, { n, sel: 'main', included: urls });
    if (!r) { sections.push(`<section id="p${n}" class="s2p-page"><p>[렌더 실패: ${u}]</p></section>`); continue; }
    r.css.forEach(c => styles.add(c));
    sections.push(`<section id="p${n}" class="s2p-page">${r.html}</section>`);
  }
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>site2pdf PoC 통합본 (B)</title>
${[...styles].map(h => `<link rel="stylesheet" href="${h}">`).join('\n')}
<style>${GENERIC_PRINT_CSS} .s2p-page{margin:0!important;max-width:none!important} .s2p-page + .s2p-page{break-before:page}</style></head>
<body>${sections.join('\n')}</body></html>`;
  // 같은 origin에서 열어야 상대 경로/정책 판단이 일관됨 → 빈 문서로 이동 후 setContent
  await page.goto(origin + '/docs/index.html', { waitUntil: 'commit' });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.emulateMedia({ media: 'print' });
  const file = `${OUT}/B-single-html.pdf`;
  await page.pdf({ path: file, format: 'A4', printBackground: true, outline: true, tagged: true, margin: { top: '14mm', bottom: '14mm', left: '14mm', right: '14mm' } });
  await page.close();
  const info = await inspectPdf(file);
  return { file, totalMs: Date.now() - t0, pages: info.pages, outline: info.outline, links: info.links, sizeKB: Math.round(fs.statSync(file).size / 1024) };
}

export async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const stat = await startFixtureServer({ root: '../fixtures/static-site', vars: { NEXT: '2' } });
  const urls = ['/docs/index.html', '/docs/guide/intro.html', '/docs/guide/install.html', '/docs/api/overview.html', '/docs/api/reference.html'].map(p => stat.origin + p);
  const browser = await launch();
  const ctx = await safeContext(browser, [stat.origin]);
  const A = await approachA(ctx, urls, stat.origin);
  const B = await approachB(ctx, urls, stat.origin);
  await browser.close(); await stat.close();
  const res = JSON.parse(JSON.stringify({ A, B }).split(stat.origin).join('{STATIC}'));
  fs.writeFileSync('../output/poc/merge.json', JSON.stringify(res, null, 2));
  return res;
}

if (process.argv[1].endsWith('03-merge.mjs')) {
  const r = await run();
  for (const [k, v] of Object.entries(r)) {
    console.log(`\n## ${k}: pages=${v.pages} size=${v.sizeKB}KB links(uri/internal)=${v.links.uri}/${v.links.internal} ${JSON.stringify(v.rewrite ?? '')}`);
    console.log('  outline:\n   ' + v.outline.join('\n   '));
    if (v.pageMap) console.log('  pageMap: ' + v.pageMap.join(', '));
    console.log('  uri samples: ' + v.links.uriSamples.join(' , '));
  }
}
