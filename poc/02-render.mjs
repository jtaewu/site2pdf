// PoC 2: HTML→PDF 렌더링 변형 비교 + 자동 잘림(텍스트 커버리지/가로 넘침) 검사
import fs from 'node:fs';
import { startFixtureServer } from './lib/server.mjs';
import { launch, safeContext, waitForStable } from './lib/browser.mjs';
import { inspectPdf } from './lib/pdfcheck.mjs';

const OUT = '../output/poc/pdf';
const MARGIN_MM = 14;
const PRINTABLE_PX = Math.floor((210 - 2 * MARGIN_MM) / 25.4 * 96); // A4 가로 인쇄 가능 폭(px)

// docs/06 §3 기본 CSS + 넓은 표/긴 단어 대응. 사이트 비의존적 규칙만 포함
export const GENERIC_PRINT_CSS = `
@page { size: A4; margin: ${MARGIN_MM}mm; }
pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
img, svg, video, canvas { max-width: 100% !important; height: auto !important; }
table { max-width: 100% !important; }
td, th { white-space: normal !important; overflow-wrap: anywhere !important; }
h1, h2, h3 { break-after: avoid; }
pre, tr, img { break-inside: avoid-page; }
`;

/** 인쇄 전 페이지 정리. opts.fixed: 'keep'|'hide', opts.contentSelector: 설정으로만 주입(코어 하드코딩 금지) */
export async function preparePage(page, { css = true, fixed = 'keep', contentSelector = null } = {}) {
  await page.emulateMedia({ media: 'print' });
  if (css) await page.addStyleTag({ content: GENERIC_PRINT_CSS });
  return page.evaluate(({ fixed, contentSelector }) => {
    const notes = [];
    if (contentSelector) {
      const el = document.querySelector(contentSelector);
      if (!el) notes.push('contentSelector-not-found');
      else { document.body.replaceChildren(el); el.style.margin = '0'; el.style.maxWidth = 'none'; notes.push('contentSelector-applied'); }
    }
    if (fixed === 'hide') {
      let n = 0;
      for (const el of document.querySelectorAll('body *')) {
        const p = getComputedStyle(el).position;
        if (p === 'fixed' || p === 'sticky') { el.style.setProperty('display', 'none', 'important'); n++; }
      }
      notes.push(`fixed-hidden=${n}`);
    }
    return notes;
  }, { fixed, contentSelector });
}

/** 인쇄 폭 기준 가로 넘침 요소 탐지 */
export async function detectOverflow(page) {
  await page.setViewportSize({ width: PRINTABLE_PX, height: 1000 });
  return page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && r.right > W + 2 && !['HTML', 'BODY'].includes(el.tagName)) {
        // 조상이 이미 보고되었으면 생략
        if (!out.some(o => o.el.contains(el))) out.push({ el, tag: el.tagName.toLowerCase(), right: Math.round(r.right) });
      }
    }
    return { pageWidth: W, items: out.slice(0, 5).map(({ tag, right }) => ({ tag, right })), count: out.length };
  });
}

/** DOM에 보이는 단어가 PDF 텍스트에 얼마나 남았는지(잘림·누락 지표) */
export async function textCoverage(page, pdfText) {
  const words = await page.evaluate(() => [...new Set(document.body.innerText.split(/\s+/).filter(w => w.length >= 2))]);
  const flat = pdfText.replace(/\s+/g, '');
  const missing = words.filter(w => !flat.includes(w));
  return { words: words.length, missing: missing.length, ratio: +(1 - missing.length / Math.max(1, words.length)).toFixed(4), missingSamples: missing.slice(0, 5) };
}

export async function renderOne(ctx, url, file, variant, { timeoutMs = 8000 } = {}) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
    const st = await waitForStable(page, { timeoutMs });
    const notes = await preparePage(page, variant);
    const overflow = await detectOverflow(page);
    await page.pdf({ path: file, format: 'A4', printBackground: true, outline: true, tagged: true, preferCSSPageSize: true,
      margin: { top: `${MARGIN_MM}mm`, bottom: `${MARGIN_MM}mm`, left: `${MARGIN_MM}mm`, right: `${MARGIN_MM}mm` } });
    const pdf = await inspectPdf(file);
    const cov = await textCoverage(page, pdf.text);
    return { url, file, status: resp?.status(), stable: st.stable, ms: Date.now() - t0, notes, overflow: { count: overflow.count, items: overflow.items }, pdfPages: pdf.pages, outline: pdf.outline, links: pdf.links, coverage: cov };
  } catch (e) {
    return { url, file, status: 'failed', error: e.message.split('\n')[0], ms: Date.now() - t0 };
  } finally { await page.close(); }
}

export const VARIANTS = {
  'v1-as-is': { css: false, fixed: 'keep' },
  'v2-generic-css': { css: true, fixed: 'hide' },
  'v3-content-selector': { css: true, fixed: 'hide', contentSelector: 'main' }, // 사이트별 설정값 예시
};

export async function run() {
  const stat = await startFixtureServer({ root: '../fixtures/static-site', vars: { NEXT: '2' } });
  const spa = await startFixtureServer({ root: '../fixtures/spa-site', spaPrefix: '/app/' });
  const pages = [
    [stat.origin, '/docs/index.html'], [stat.origin, '/docs/guide/intro.html'], [stat.origin, '/docs/guide/install.html'],
    [stat.origin, '/docs/api/overview.html'], [stat.origin, '/docs/api/reference.html'],
    [spa.origin, '/app/guide'], [spa.origin, '/app/slow'],
  ];
  const browser = await launch();
  const results = {};
  for (const [name, variant] of Object.entries(VARIANTS)) {
    fs.mkdirSync(`${OUT}/${name}`, { recursive: true });
    const blocked = [];
    const ctx = await safeContext(browser, [stat.origin, spa.origin], { blocked });
    results[name] = [];
    let i = 0;
    for (const [o, p] of pages) {
      const file = `${OUT}/${name}/${String(++i).padStart(3, '0')}-${p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.pdf`;
      const r = await renderOne(ctx, o + p, file, variant, { timeoutMs: 6000 });
      r.blocked = blocked.splice(0).map(b => `${b.type} ${b.url}`);
      results[name].push(r);
    }
    await ctx.close();
  }
  await browser.close(); await stat.close(); await spa.close();
  const json = JSON.stringify(results, null, 2).split(stat.origin).join('{STATIC}').split(spa.origin).join('{SPA}');
  fs.writeFileSync('../output/poc/render.json', json);
  return JSON.parse(json);
}

if (process.argv[1].endsWith('02-render.mjs')) {
  const r = await run();
  for (const [v, list] of Object.entries(r)) {
    console.log(`\n## ${v}`);
    for (const x of list) {
      if (x.error) { console.log(`  FAIL ${x.url} ${x.error}`); continue; }
      console.log(`  ${x.url.padEnd(34)} pages=${x.pdfPages} cov=${x.coverage.ratio} miss=${x.coverage.missing} overflow=${x.overflow.count}${x.overflow.items.map(i => ' ' + i.tag + '@' + i.right).join('')} outline=${x.outline.length} links(uri/int)=${x.links.uri}/${x.links.internal} ${x.ms}ms notes=${x.notes.join(',')} blocked=${x.blocked.length}`);
      if (x.coverage.missing) console.log(`     누락 예: ${x.coverage.missingSamples.join(' | ').slice(0, 160)}`);
    }
  }
}
