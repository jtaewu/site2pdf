// 브라우저 E2E: 로컬 모드 탐색 (SC-02, SC-09, SC-10, T-11/T-12 탐색 부분, T-17)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.ts';
import { openSession } from '../../src/session.ts';
import { crawl } from '../../src/discover/crawler.ts';
import { createSelector } from '../../src/discover/selection.ts';
import { main } from '../../src/cli/index.ts';

const FIX = path.resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];
const tmpOut = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-out-'));
  tmpDirs.push(d);
  return d;
};
afterAll(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const writeCfg = (dir: string, data: unknown) => {
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
};

describe('로컬 정적 사이트 (fixtures/static-site)', () => {
  it('CLI discover: 7페이지 발견, 범위 밖 링크 제외, 외부 이미지 차단, 종료 코드 0', async () => {
    const out = tmpOut();
    const cfg = writeCfg(out, {
      mode: 'local', sourcePath: path.join(FIX, 'static-site'), startPath: '/docs/index.html',
      scope: { pathPrefixes: ['/docs'], denyPatterns: ['/private/'] },
      crawl: { minDelayMs: 0 },
      selection: { exclude: ['/docs/list.html'] },
    });
    const code = await main(['discover', '-c', cfg, '-o', out]);
    expect(code).toBe(0);
    const d = JSON.parse(fs.readFileSync(path.join(out, 'discovered.json'), 'utf8'));
    expect(d.pages.map((p: { path: string }) => p.path)).toEqual([
      '/docs/index.html', '/docs/guide/intro.html', '/docs/guide/install.html', '/docs/api/overview.html', '/docs/api/reference.html', '/docs/list.html',
      '/docs/guide/media.html', // 깊이 2 (intro 본문 링크)
    ]);
    expect(d.pages.every((p: { status: string }) => p.status === 'ok')).toBe(true);
    // T-10: 선택 제외는 기록만 하고 탐색 목록에는 남는다
    expect(d.pages[5]).toMatchObject({ path: '/docs/list.html', selected: false, selectionReason: 'selection-exclude:/docs/list.html' });
    expect(d.result.counts).toMatchObject({ pages: 7, ok: 7, failed: 0, selected: 6 });
    const reasons = Object.fromEntries(d.excluded.map((e: { url: string; reason: string }) => [e.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), e.reason]));
    expect(reasons).toMatchObject({
      '/logout': 'path-out-of-scope', 'https://example.invalid/external': 'origin-out-of-scope', '/admin/': 'path-out-of-scope',
      '/docs/private/secret.html': 'deny:/private/', 'mailto:a@example.invalid': 'scheme:mailto', 'javascript:void(0)': 'scheme:javascript',
      '/docs/files/manual.zip': 'download-extension',
    });
    expect(d.blockedRequests).toContainEqual(expect.objectContaining({ type: 'image', origin: 'https://example.invalid' }));
    expect(d.robots).toEqual({ state: 'not-applicable' });
  });

  it('T-17 오프라인: 허용된 이그레스는 로컬 서버뿐이고, 그 외 목적지는 전부 거부된다', async () => {
    const config = configSchema.parse({ mode: 'local', sourcePath: path.join(FIX, 'static-site'), startPath: '/docs/index.html', scope: { pathPrefixes: ['/docs'] }, crawl: { minDelayMs: 0 } });
    const s = await openSession(config);
    try {
      await crawl({ startUrl: s.startUrl, scope: s.scope, crawl: config.crawl, load: s.load, select: createSelector(config.selection) });
      const local = new URL(s.localOrigin!).host;
      const allowedTargets = s.egress.decisions.filter((d) => d.allowed).map((d) => d.target.split('/')[0]);
      expect(allowedTargets.length).toBeGreaterThan(0);
      expect(new Set(allowedTargets)).toEqual(new Set([local]));
      expect(s.blocked.map((b) => b.url)).toContain('https://example.invalid/logo.png');
    } finally {
      await s.close();
    }
  });
});

describe('로컬 SPA (fixtures/spa-site)', () => {
  const spa = (render: Record<string, unknown> = {}) => ({
    mode: 'local', sourcePath: path.join(FIX, 'spa-site'), startPath: '/app/', spaFallbackPrefix: '/app/',
    scope: { pathPrefixes: ['/app'] }, crawl: { minDelayMs: 0, timeoutMs: 5000 }, render,
  });

  it('T-12 JS 렌더링 링크를 발견하고, 끝나지 않는 라우트는 실패로 기록하며 종료 코드 3', async () => {
    const out = tmpOut();
    const code = await main(['discover', '-c', writeCfg(out, spa()), '-o', out]);
    const d = JSON.parse(fs.readFileSync(path.join(out, 'discovered.json'), 'utf8'));
    const rows = d.pages.map((p: { path: string; status: string; failure?: string }) => [p.path, p.status, p.failure ?? '']);
    expect(rows).toEqual([
      ['/app/', 'ok', ''], ['/app/guide', 'ok', ''], ['/app/api', 'ok', ''], ['/app/slow', 'failed', 'content-too-short'],
    ]);
    expect(code).toBe(3);
    expect(d.message).toContain('전체 성공이 아닙니다');
  });

  it('readySelector 설정 시 신호가 없는 라우트는 ready-selector-not-found', async () => {
    const out = tmpOut();
    await main(['discover', '-c', writeCfg(out, spa({ readySelector: 'main h1' })), '-o', out]);
    const d = JSON.parse(fs.readFileSync(path.join(out, 'discovered.json'), 'utf8'));
    expect(d.pages.find((p: { path: string }) => p.path === '/app/slow')).toMatchObject({ status: 'failed', failure: 'ready-selector-not-found' });
  });
});

describe('CLI audit / 입력 오류', () => {
  it('audit: 시작 페이지·링크 통계·sitemap을 진단한다', async () => {
    const out = tmpOut();
    const code = await main(['audit', '--source', path.join(FIX, 'static-site'), '-c', writeCfg(out, { mode: 'local', sourcePath: '.', startPath: '/docs/index.html', scope: { pathPrefixes: ['/docs'] } }), '-o', out]);
    expect(code).toBe(0);
    const a = JSON.parse(fs.readFileSync(path.join(out, 'audit.json'), 'utf8'));
    expect(a.startPage).toMatchObject({ httpStatus: 200, failure: null, title: '홈 | Fixture Docs' });
    // deny 패턴을 주지 않았으므로 /docs/private/secret.html 도 범위 안 (6 + 1)
    expect(a.links.inScope).toBe(7);
    expect(a.sitemap).toMatchObject({ status: 200, urls: 3 });
  });

  it.each([
    [['discover', '--url', 'http://docs.example.com/']],
    [['discover', '--url', 'https://127.0.0.1/']],
    [['discover', '--url', 'https://a.example.com/', '--source', '.']],
    [['unknown']],
    [['discover', '--browser-channel', 'firefox', '--source', '.']],
  ])('%j → 종료 코드 2', async (argv) => {
    expect(await main(argv)).toBe(2);
  });
});
