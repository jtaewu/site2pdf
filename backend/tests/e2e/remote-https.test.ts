// 브라우저 E2E: 원격(HTTPS) 모드 전체 경로 (T-01, T-04, T-08, SC-01/02/04/08/11)
// 실제 인터넷 대신 루프백 HTTPS fixture(테스트 전용 자체 서명 인증서)를 쓰고, 가짜 DNS로 docs.test → 127.0.0.1.
// 테스트 전용 옵션(testOnly)은 CLI·설정 파일로 켤 수 없다.
import fs from 'node:fs';
import https from 'node:https';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadConfig } from '../../src/config/load.ts';
import { runAudit } from '../../src/audit/command.ts';
import { runDiscover } from '../../src/discover/command.ts';
import { runGenerate } from '../../src/generate/command.ts';
import { resolveInsideRoot } from '../../src/local/static-server.ts';
import type { SessionOptions } from '../../src/session.ts';

const FIX = path.resolve(import.meta.dirname, '../../../fixtures');
const SITE = fs.realpathSync(path.join(FIX, 'static-site'));
let server: https.Server;
let port = 0;
let robots: { status: number; body: string } = { status: 404, body: '' };
const hits: string[] = [];
const tmpDirs: string[] = [];

beforeAll(async () => {
  server = https.createServer(
    { key: fs.readFileSync(path.join(FIX, 'tls/docs.test.key')), cert: fs.readFileSync(path.join(FIX, 'tls/docs.test.crt')) },
    (req, res) => {
      const p = new URL(req.url ?? '/', 'https://docs.test').pathname;
      hits.push(p);
      if (p === '/robots.txt') return res.writeHead(robots.status, { 'content-type': 'text/plain' }).end(robots.body);
      if (p === '/docs/forbidden.html') return res.writeHead(403).end('forbidden');
      if (p === '/docs/redirect-internal') return res.writeHead(302, { location: 'http://127.0.0.1:8080/admin' }).end();
      const r = resolveInsideRoot(SITE, p);
      if ('status' in r) return res.writeHead(r.status).end();
      const type = r.file.endsWith('.html') ? 'text/html; charset=utf-8' : r.file.endsWith('.css') ? 'text/css' : r.file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(r.file));
    },
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const opts = (): SessionOptions => ({
  resolver: async (h) => (h === 'docs.test' ? ['127.0.0.1'] : []),
  testOnly: { privateExceptions: ['docs.test:443'], portMap: { 'docs.test:443': port }, ignoreHTTPSErrors: true },
});

async function linkUris(file: string): Promise<string[]> {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) for (const a of await (await doc.getPage(i)).getAnnotations()) if (a.subtype === 'Link' && a.url) out.push(a.url);
  await doc.destroy();
  return out;
}

function remoteConfig(startPath = '/docs/index.html', extra: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-remote-'));
  tmpDirs.push(dir);
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ mode: 'remote', startUrl: `https://docs.test${startPath}`, scope: { pathPrefixes: ['/docs'], denyPatterns: ['/private/'] }, crawl: { minDelayMs: 500 }, ...extra }));
  return { ...loadConfig({ configPath: f }), out: dir };
}

describe('원격 HTTPS 모드', () => {
  it('T-01/SC-04 robots를 지키며 탐색·변환하고, 원격 PDF에는 포함 페이지 웹 주소 링크를 남긴다', async () => {
    robots = { status: 200, body: 'User-agent: *\nDisallow: /docs/guide/install.html\n' };
    hits.length = 0;
    const { config, configHash, out } = remoteConfig();
    const r = await runGenerate(config, configHash, out, opts());
    expect(r.exitCode).toBe(0);
    const d = JSON.parse(fs.readFileSync(path.join(out, 'discovered.json'), 'utf8'));
    expect(d.robots).toMatchObject({ state: 'present' });
    expect(d.excluded).toContainEqual(expect.objectContaining({ url: 'https://docs.test/docs/guide/install.html', reason: 'robots-disallow' }));
    // robots가 금지한 페이지는 한 번도 요청하지 않았다
    expect(hits).not.toContain('/docs/guide/install.html');
    expect(r.pages.map((p) => p.path)).toEqual(['/docs/index.html', '/docs/guide/intro.html', '/docs/api/overview.html', '/docs/api/reference.html', '/docs/list.html', '/docs/guide/media.html']);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    expect(m.combined.links.anchorExact).toBeGreaterThanOrEqual(2);
    // 이그레스는 docs.test:443 하나로만 나갔다
    expect(m.egressDenied).toEqual([]);
    // 원격 페이지별 PDF: 포함 페이지 링크는 웹 주소로 유지, 제외 페이지(/admin, /private) 링크는 제거
    const uris = await linkUris(path.join(out, r.pages[0]!.pdfFile!));
    expect(uris).toContain('https://docs.test/docs/guide/intro.html');
    expect(uris).toContain('https://example.invalid/external');
    expect(uris.filter((u) => /\/admin\/|\/private\/|\/logout/.test(u))).toEqual([]);
  }, 180_000);

  it('audit: robots·시작 페이지·sitemap·렌더 설정 후보를 진단한다', async () => {
    robots = { status: 404, body: '' };
    const { config, configHash, out } = remoteConfig();
    const r = await runAudit(config, configHash, out, opts());
    expect(r.exitCode).toBe(0);
    const a = JSON.parse(fs.readFileSync(path.join(out, 'audit.json'), 'utf8'));
    expect(a.robots).toMatchObject({ state: 'absent', status: 404 });
    expect(a.startPage).toMatchObject({ httpStatus: 200, title: '홈 | Fixture Docs' });
    expect(a.renderSuggestion).toMatchObject({ contentSelector: 'main', readySelector: 'main h1' });
  }, 60_000);

  it.each([
    ['robots가 전체 금지', { status: 200, body: 'User-agent: *\nDisallow: /\n' }, 'robots.txt가 시작 URL'],
    ['robots 확인 실패(500)', { status: 500, body: '' }, 'robots.txt를 확인할 수 없어'],
  ])('T-08 %s → 우회 없이 중지, 종료 코드 2', async (_n, rb, msg) => {
    robots = rb;
    hits.length = 0;
    const { config, configHash, out } = remoteConfig();
    const r = await runDiscover(config, configHash, out, opts());
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain(msg);
    expect(hits.filter((h) => h !== '/robots.txt')).toEqual([]);
  }, 60_000);

  it('SC-11 시작 페이지 403 → 우회하지 않고 중지, 종료 코드 2', async () => {
    robots = { status: 404, body: '' };
    const { config, configHash, out } = remoteConfig('/docs/forbidden.html');
    const r = await runDiscover(config, configHash, out, opts());
    expect(r.exitCode).toBe(2);
    expect(r.result?.stopReason).toBe('access-denied');
  }, 60_000);

  it('SC-08 시작 페이지가 내부 IP로 리다이렉트 → 프록시가 막고 보안 오류(4)', async () => {
    robots = { status: 404, body: '' };
    const { config, configHash, out } = remoteConfig('/docs/redirect-internal');
    const r = await runDiscover(config, configHash, out, opts());
    expect(r.exitCode).toBe(4);
    expect(r.result?.pages[0]?.failure).toBe('egress-blocked:host-not-allowed');
  }, 60_000);
});
