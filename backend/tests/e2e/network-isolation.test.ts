// 브라우저 E2E: 페이지 JS·서버 리다이렉트·DNS 재바인딩으로 범위 밖에 도달하는지 sentinel로 측정 (T-04, T-05, ADR-004)
// 모든 통신은 루프백 안에서만 일어난다. 테스트 호스트명은 가짜 DNS로만 해석한다.
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy } from '../../src/fetch-policy/egress-proxy.ts';
import { launchBrowser } from '../../src/browser/launch.ts';
import { createSafeContext } from '../../src/browser/context.ts';
import { createBrowserPageLoader } from '../../src/browser/page-loader.ts';
import { renderSchema } from '../../src/config/schema.ts';

const FIX = path.resolve(import.meta.dirname, '../../../fixtures/security-site');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sentinel: http.Server;
let site: http.Server;
let sPort = 0;
let fPort = 0;
const hits: string[] = [];

async function listen(s: http.Server) {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as net.AddressInfo).port;
}

beforeAll(async () => {
  sentinel = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end('sentinel');
  });
  sentinel.on('upgrade', (req, sock) => {
    hits.push(`UPGRADE ${req.url}`);
    sock.destroy();
  });
  sPort = await listen(sentinel);
  const attack = fs.readFileSync(path.join(FIX, 'attack.html'), 'utf8');
  const sw = fs.readFileSync(path.join(FIX, 'sw.js'), 'utf8');
  site = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const html = (target: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(attack.replaceAll('__SENTINEL__', target));
    if (p === '/attack-direct.html') return html(`http://127.0.0.1:${sPort}`);
    if (p === '/attack-rebind.html') return html(`http://rebind.test:${sPort}`);
    if (p === '/sw.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(sw.replaceAll('__SENTINEL__', `http://127.0.0.1:${sPort}`));
    if (p === '/redirect-loopback') return res.writeHead(302, { location: `http://127.0.0.1:${sPort}/via-302` }).end();
    if (p === '/redirect-metadata') return res.writeHead(302, { location: `http://169.254.169.254:${sPort}/latest/meta-data` }).end();
    if (p === '/redirect-rebind') return res.writeHead(302, { location: `http://rebind.test:${sPort}/via-302-rebind` }).end();
    res.writeHead(404).end();
  });
  fPort = await listen(site);
});
afterAll(async () => {
  sentinel.closeAllConnections();
  site.closeAllConnections();
  await new Promise<void>((r) => sentinel.close(() => r()));
  await new Promise<void>((r) => site.close(() => r()));
});

describe('네트워크 격리', () => {
  it('대조군: 방어 없는 브라우저에서는 공격 페이지가 sentinel에 실제로 도달한다 (테스트 유효성 확인)', async () => {
    hits.length = 0;
    const b = await chromium.launch();
    try {
      const p = await b.newPage();
      await p.goto(`http://127.0.0.1:${fPort}/attack-direct.html`);
      await sleep(3000);
    } finally {
      await b.close();
    }
    expect(hits.length).toBeGreaterThan(5);
  });

  it('프록시 + 안전 컨텍스트: 페이지 JS·리다이렉트·재바인딩 어떤 경로로도 sentinel 도달 0건', async () => {
    hits.length = 0;
    const docsOrigin = `http://docs.test:${fPort}`;
    // rebind.test 는 "앱이 사전 검증을 통과시켜 허용 목록에 넣은" 상황을 가정, 실제 연결 시점에는 루프백으로 해석
    const proxy = await startEgressProxy({
      allowedHostPorts: [`docs.test:${fPort}`, `rebind.test:${sPort}`],
      privateExceptions: [`docs.test:${fPort}`],
      resolve: async (h) => (h === 'docs.test' || h === 'rebind.test' ? ['127.0.0.1'] : []),
    });
    const browser = await launchBrowser({ proxyUrl: proxy.url });
    try {
      const { context, blocked } = await createSafeContext(browser, { pageOrigins: [docsOrigin], resourceOrigins: [`http://rebind.test:${sPort}`] });
      const load = createBrowserPageLoader(context, renderSchema.parse({ minTextLength: 0 }), 8000);
      const results: Record<string, string | undefined> = {};
      for (const p of ['/attack-direct.html', '/attack-rebind.html', '/redirect-loopback', '/redirect-metadata', '/redirect-rebind']) {
        const r = await load(`${docsOrigin}${p}`);
        results[p] = r.failure;
        await sleep(p.startsWith('/attack') ? 3000 : 300);
      }
      expect(hits).toEqual([]);
      // 리다이렉트는 프록시가 막고, 실패로 기록된다 (에러 화면을 성공으로 위장하지 않음)
      expect(results['/redirect-loopback']).toBe('egress-blocked:host-not-allowed');
      expect(results['/redirect-metadata']).toBe('egress-blocked:host-not-allowed');
      expect(results['/redirect-rebind']).toBe('egress-blocked:non-public-address');
      // 브라우저 계층(L-B)에서도 여러 유형을 차단했다
      const types = new Set(blocked.map((b) => b.type));
      for (const t of ['websocket', 'fetch', 'image', 'stylesheet']) expect(types).toContain(t);
      expect(proxy.decisions.some((d) => !d.allowed && d.reason === 'non-public-address')).toBe(true);
      await context.close();
    } finally {
      await browser.close();
      await proxy.close();
    }
  });
});
