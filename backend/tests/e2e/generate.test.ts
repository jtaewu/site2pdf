// 브라우저 E2E: PDF 생성 (T-11~T-15, SC-04, FR-06/07/10, D-10)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { main } from '../../src/cli/index.ts';

const FIX = path.resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-gen-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const writeCfg = (dir: string, data: unknown, name = 'config.json') => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
};
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

type Link = { url?: string; destPage?: number; destY?: number | null };
async function inspect(file: string) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const pages: Array<{ text: string; links: Link[]; height: number }> = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const text = (await p.getTextContent()).items.map((t) => ('str' in t ? t.str : '')).join('');
    const links: Link[] = [];
    for (const a of await p.getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      if (a.url) links.push({ url: a.url });
      else if (Array.isArray(a.dest)) links.push({ destPage: await doc.getPageIndex(a.dest[0]), destY: typeof a.dest[3] === 'number' ? a.dest[3] : null });
    }
    pages.push({ text, links, height: p.view[3]! });
  }
  const outline: Array<{ title: string; children: number }> = ((await doc.getOutline()) ?? []).map((o) => ({ title: o.title, children: o.items.length }));
  await doc.destroy();
  return { pages, outline };
}

const staticCfg = {
  mode: 'local', sourcePath: path.join(FIX, 'static-site'), startPath: '/docs/index.html',
  scope: { pathPrefixes: ['/docs'], denyPatterns: ['/private/'] }, crawl: { minDelayMs: 0 },
};

describe('정적 사이트 generate (T-11, T-13, T-14, T-15)', () => {
  let out: string;
  let code: number;
  let m: ReturnType<typeof readJson>;
  let combined: Awaited<ReturnType<typeof inspect>>;

  beforeAll(async () => {
    out = tmp();
    code = await main(['generate', '-c', writeCfg(out, staticCfg), '-o', out]);
    m = readJson(path.join(out, 'manifest.json'));
    combined = await inspect(path.join(out, m.combined.file));
  }, 180_000);

  it('T-11 페이지별 PDF 7개와 통합 PDF, manifest·report를 만든다', () => {
    expect(code).toBe(0);
    expect(m.summary).toMatchObject({ planned: 7, rendered: 7, failed: 0 });
    for (const p of m.pages) expect(fs.existsSync(path.join(out, p.pdfFile))).toBe(true);
    expect(m.pages[0].pdfFile).toBe('pdf/pages/001-Fixture-문서-홈.pdf');
    expect(fs.readFileSync(path.join(out, 'report.md'), 'utf8')).toContain('육안 검수 체크리스트');
  });

  it('T-15 통합 PDF 순서·쪽수·북마크가 manifest와 일치한다', () => {
    const total = m.pages.reduce((n: number, p: { pdfPages: number }) => n + p.pdfPages, 0);
    expect(combined.pages.length).toBe(total);
    let expectStart = 1;
    for (const p of m.pages) {
      expect(p.combinedStartPage).toBe(expectStart);
      expectStart += p.pdfPages;
    }
    expect(combined.outline.map((o) => o.title)).toEqual(m.pages.map((p: { title: string }) => p.title));
    // 장 아래에 h2 북마크가 붙는다 (2단계)
    expect(combined.outline.find((o) => o.title === 'API 레퍼런스')?.children).toBe(2);
    // 각 장 시작 페이지에 그 장 제목이 있다
    for (const p of m.pages) expect(combined.pages[p.combinedStartPage - 1]!.text).toContain(p.title);
  });

  it('T-13 한글·긴 코드·넓은 표·이미지가 잘리지 않고 텍스트로 검색된다', () => {
    const all = combined.pages.map((p) => p.text).join('\n').replace(/\s+/g, '');
    for (const s of ['가나다라마바사결제승인', '한글메모90', 'PAYMENT_ERROR_CODE_25', '2026-11-24T00:00:00+09:00', 'registry.example.invalid']) {
      expect(all).toContain(s.replace(/\s+/g, ''));
    }
    for (const p of m.pages) {
      expect(p.qa.coverage).toBe(1);
      expect(p.qa.overflow).toEqual([]);
    }
  });

  it('T-14 같은 사이트 iframe은 펼쳐 인쇄, 동영상·캔버스는 경고, 차단 리소스는 기록', () => {
    const media = m.pages.find((p: { path: string }) => p.path === '/docs/guide/media.html');
    expect(media.warnings).toEqual(expect.arrayContaining(['iframe-expanded:1', 'unsupported-content:videox1', 'unsupported-content:canvasx1']));
    expect(media.warnings).not.toContain('unsupported-content:iframex1');
    const intro = m.pages.find((p: { path: string }) => p.path === '/docs/guide/intro.html');
    expect(intro.blocked).toContain('image https://example.invalid/logo.png');
  });

  it('D-10 링크: 포함 페이지는 내부 이동(앵커 위치까지), 제외 페이지는 제거, 외부는 유지, 루프백 주소는 남기지 않는다', () => {
    const local = m.input.localOrigin.replace(/\/$/, '');
    const uris = combined.pages.flatMap((p) => p.links.filter((l) => l.url).map((l) => l.url!));
    expect(uris.some((u) => u.startsWith(local))).toBe(false);
    expect(uris).toEqual(expect.arrayContaining(['https://example.invalid/external', 'mailto:a@example.invalid']));
    // 시작하기 → API 레퍼런스#errors : 표 제목 위치(페이지 맨 위가 아님)
    const introStart = m.pages.find((p: { path: string }) => p.path === '/docs/guide/intro.html').combinedStartPage - 1;
    const gotos = combined.pages[introStart]!.links.filter((l) => l.destPage !== undefined).map((l) => l.destPage);
    // 앵커 링크는 장 첫 쪽이 아니라 해당 제목이 실제로 있는 쪽으로 이동해야 한다
    const pageWith = (s: string) => combined.pages.findIndex((p) => p.text.replace(/\s+/g, '').includes(s));
    const errorsPage = pageWith('오류코드(넓은표)');
    const koreanAnchorPage = pageWith('이제목은한글id를');
    expect(errorsPage).toBeGreaterThan(m.pages.find((p: { path: string }) => p.path === '/docs/api/reference.html').combinedStartPage - 1);
    expect(koreanAnchorPage).toBeGreaterThan(m.pages.find((p: { path: string }) => p.path === '/docs/guide/media.html').combinedStartPage - 1);
    expect(gotos).toContain(errorsPage);
    expect(gotos).toContain(koreanAnchorPage);
    // 시작하기 본문의 #errors·#한글-앵커 2개 + 미디어 페이지에 펼쳐 인쇄된 iframe(시작하기 페이지) 본문의 같은 링크 2개
    expect(m.combined.links.anchorExact).toBe(4);
    expect(m.combined.links.brokenNamed).toBe(0);
  });

  it('페이지별 PDF(로컬 모드)에도 루프백 주소 링크가 남지 않는다', async () => {
    const local = m.input.localOrigin.replace(/\/$/, '');
    for (const p of m.pages) {
      const info = await inspect(path.join(out, p.pdfFile));
      const uris = info.pages.flatMap((x) => x.links.filter((l) => l.url).map((l) => l.url!));
      expect(uris.filter((u) => u.startsWith(local))).toEqual([]);
    }
  });
});

describe('SPA generate (T-12)', () => {
  it('readySelector로 렌더 완료를 판정하고, 끝나지 않는 라우트는 실패로 남기고 종료 코드 3', async () => {
    const out = tmp();
    const code = await main(['generate', '-c', path.resolve(FIX, '../config/examples/local-spa.json'), '-o', out]);
    const m = readJson(path.join(out, 'manifest.json'));
    expect(code).toBe(3);
    // discover 단계에서 실패한 /app/slow 는 변환 대상에서 빠지고 사유가 남는다
    expect(m.skipped).toContainEqual({ path: '/app/slow', reason: 'discover-failed:ready-selector-not-found' });
    expect(m.pages.map((p: { title: string; status: string }) => [p.title, p.status])).toEqual([['SPA 홈', 'rendered'], ['SPA 가이드', 'rendered'], ['SPA API', 'rendered']]);
    const c = await inspect(path.join(out, m.combined.file));
    expect(c.pages.map((p) => p.text).join('')).toContain('동적렌더링확인');
    expect(m.message).toContain('탐색 단계에 실패');
  }, 120_000);
});

describe('검수된 목록으로 generate (--discovered, SC-03/SC-04)', () => {
  it('discover 결과의 선택 페이지만 지정 순서로 변환하고, 설정이 바뀌면 거부한다', async () => {
    const out = tmp();
    const cfg = writeCfg(out, { ...staticCfg, selection: { exclude: ['/docs/list.html', '/docs/guide/media.html'], order: ['/docs/api/reference.html'] } });
    expect(await main(['discover', '-c', cfg, '-o', out])).toBe(0);
    const discovered = path.join(out, 'discovered.json');
    // 검수 중 누군가 범위 밖 페이지를 끼워 넣어도 다시 걸러진다
    const d = readJson(discovered);
    d.pages.push({ ...d.pages[0], order: 99, path: '/admin/', url: 'x' });
    fs.writeFileSync(discovered, JSON.stringify(d));

    expect(await main(['generate', '-c', cfg, '-o', out, '--discovered', discovered])).toBe(0);
    const m = readJson(path.join(out, 'manifest.json'));
    expect(m.pages.map((p: { path: string }) => p.path)).toEqual([
      '/docs/api/reference.html', '/docs/index.html', '/docs/guide/intro.html', '/docs/guide/install.html', '/docs/api/overview.html',
    ]);
    expect(m.skipped).toEqual(expect.arrayContaining([
      { path: '/docs/list.html', reason: 'selection-exclude:/docs/list.html' },
      { path: '/admin/', reason: 'out-of-scope:path-out-of-scope' },
    ]));

    const changed = writeCfg(out, { ...staticCfg, crawl: { minDelayMs: 0, maxPages: 3 } }, 'changed.json');
    expect(await main(['generate', '-c', changed, '-o', out, '--discovered', discovered])).toBe(2);
  }, 180_000);
});
