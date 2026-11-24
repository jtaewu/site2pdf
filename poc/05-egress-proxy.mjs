// PoC 5: 이그레스 프록시로 SSRF·DNS 재바인딩·리다이렉트 이탈 차단
// 브라우저의 모든 요청을 로컬 정책 프록시로 보내고, 프록시가 "한 번 해석한 IP를 검사한 뒤 그 IP로만 연결"한다(TOCTOU 제거).
// 테스트용 가짜 DNS만 사용하며 실제 인터넷으로는 연결하지 않는다(미등록 호스트는 거부).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { startFixtureServer, startSentinel } from './lib/server.mjs';
import { launch, safeContext } from './lib/browser.mjs';
import { blockedIpReason } from './lib/policy.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startEgressProxy({ resolve, testExceptions }) {
  const decisions = [];
  const decide = async (host, port) => {
    const ip = net.isIP(host.replace(/^\[|\]$/g, '')) ? host.replace(/^\[|\]$/g, '') : await resolve(host);
    if (!ip) return { ok: false, reason: 'unresolvable-or-unknown' };
    const priv = blockedIpReason(ip);
    if (priv && !testExceptions.has(`${host}:${port}`)) return { ok: false, ip, reason: priv };
    return { ok: true, ip };
  };
  const server = http.createServer(async (req, res) => {
    let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    const port = +(u.port || 80);
    const d = await decide(u.hostname, port);
    decisions.push({ kind: 'http', target: `${u.hostname}:${port}${u.pathname}`, ...d });
    if (!d.ok) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('blocked by egress policy'); }
    const up = http.request({ host: d.ip, port, path: u.pathname + u.search, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', async (req, sock, head) => {
    const [host, p] = req.url.split(/:(?=\d+$)/);
    const d = await decide(host, +p);
    decisions.push({ kind: 'connect', target: req.url, ...d });
    if (!d.ok) return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const up = net.connect(+p, d.ip, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  server.on('upgrade', (req, sock) => { decisions.push({ kind: 'upgrade', target: req.url, ok: false, reason: 'upgrade-denied' }); sock.destroy(); });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, decisions, close: () => new Promise(c => { server.closeAllConnections?.(); server.close(c); }) })));
}

export async function run() {
  const sentinel = await startSentinel();
  const sPort = new URL(sentinel.origin).port;
  // 공격 페이지가 노릴 대상: 재바인딩 호스트(rebind.test → 127.0.0.1)
  const site = await startFixtureServer({
    root: '../fixtures/security-site',
    vars: { __SENTINEL__: `http://rebind.test:${sPort}` },
    routes: {
      '/redirect-out': (req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${sPort}/via-302` }); res.end(); },
      '/redirect-meta': (req, res) => { res.writeHead(302, { location: `http://169.254.169.254:${sPort}/latest/meta-data` }); res.end(); },
    },
  });
  const fPort = new URL(site.origin).port;
  const ALLOWED = `http://docs.test:${fPort}`;

  // 가짜 DNS: rebind.test는 첫 조회(앱의 사전 검증)에는 공개 IP, 이후(실제 연결 시점)에는 127.0.0.1을 돌려준다
  let rebindCalls = 0;
  const fakeDns = async host => {
    if (host === 'docs.test') return '127.0.0.1';
    if (host === 'rebind.test') return rebindCalls++ === 0 ? '93.184.216.34' : '127.0.0.1';
    return null; // 미등록 호스트: 실제 DNS/인터넷 사용 안 함
  };
  const naiveCheck = blockedIpReason(await fakeDns('rebind.test')); // 앱이 미리 해석해 검사 → 통과(null)

  const proxy = await startEgressProxy({ resolve: fakeDns, testExceptions: new Set([`docs.test:${fPort}`]) });
  const scenarios = [];

  async function scenario(name, browserArgs, fn) {
    sentinel.hits.length = 0; proxy.decisions.length = 0;
    const b = await launch(browserArgs);
    let detail;
    try { detail = await fn(b); } catch (e) { detail = 'error: ' + e.message.split('\n')[0]; }
    await sleep(500);
    await b.close();
    scenarios.push({ name, sentinelHits: [...sentinel.hits], denied: proxy.decisions.filter(d => !d.ok).map(d => `${d.kind} ${d.target} (${d.reason}${d.ip ? ' ' + d.ip : ''})`), detail });
  }

  const visit = async (b, url, allowedOrigins, wait = 3500) => {
    const ctx = await safeContext(b, allowedOrigins);
    const p = await ctx.newPage();
    let r = '';
    try { const resp = await p.goto(url, { timeout: 6000 }); r = `status=${resp?.status()}`; } catch (e) { r = 'goto-error: ' + e.message.split('\n')[0]; }
    await sleep(wait);
    r += ` final=${p.url()}`;
    await ctx.close();
    return r;
  };

  // S1: 프록시 없음. 앱이 rebind.test를 사전 검증(공개 IP) 후 허용 origin에 추가했다고 가정 → 브라우저가 실제로는 127.0.0.1로 연결
  await scenario('S1 직접연결 + 사전DNS검증(재바인딩)', [`--host-resolver-rules=MAP rebind.test 127.0.0.1, MAP docs.test 127.0.0.1`],
    b => visit(b, `http://rebind.test:${sPort}/rebound`, [`http://rebind.test:${sPort}`], 500));
  // S2: 같은 상황, 이그레스 프록시 경유
  const PROXY = [`--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>'];
  await scenario('S2 프록시 경유 재바인딩', PROXY, b => visit(b, `http://rebind.test:${sPort}/rebound`, [`http://rebind.test:${sPort}`], 500));
  // S3: 허용 origin에서 302로 루프백/메타데이터 이동 (L2 브라우저 방어만으로는 새던 경로)
  await scenario('S3 프록시 경유 302→루프백', PROXY, async b => (await visit(b, `${ALLOWED}/redirect-out`, [ALLOWED], 300)) + ' | ' + (await visit(b, `${ALLOWED}/redirect-meta`, [ALLOWED], 300)));
  // S4: 프록시 + 브라우저 방어를 모두 쓴 상태에서 공격 페이지 전체
  await scenario('S4 프록시+L2 공격페이지', PROXY, b => visit(b, `${ALLOWED}/attack.html`, [ALLOWED]));
  // S5: 프록시만(브라우저 route 미사용). 페이지가 루프백 IP를 직접 호출
  await scenario('S5 프록시만, <-loopback> 없음', [`--proxy-server=http://127.0.0.1:${proxy.port}`], async b => {
    const ctx = await b.newContext({ serviceWorkers: 'block' });
    const p = await ctx.newPage();
    await p.goto(`${ALLOWED}/redirect-out`).catch(() => {});
    await sleep(300); const u = p.url(); await ctx.close(); return 'final=' + u;
  });

  await proxy.close(); await site.close(); await sentinel.close();
  const res = { naivePreCheckOfRebindHost: naiveCheck ?? 'pass(public IP)', scenarios };
  const json = JSON.stringify(res, null, 2).split(sentinel.origin).join('{SENTINEL}').split(`:${sPort}`).join(':{SPORT}').split(`:${fPort}`).join(':{FPORT}');
  fs.writeFileSync('../output/poc/egress-proxy.json', json);
  return JSON.parse(json);
}

if (process.argv[1].endsWith('05-egress-proxy.mjs')) {
  const r = await run();
  console.log('앱 사전 DNS 검증 결과(rebind.test):', r.naivePreCheckOfRebindHost);
  for (const s of r.scenarios) {
    console.log(`\n## ${s.name}: sentinel 도달 ${s.sentinelHits.length}건`);
    if (s.sentinelHits.length) console.log('  도달: ' + s.sentinelHits.join(' | '));
    console.log('  프록시 거부: ' + (s.denied.join(' | ') || '-'));
    console.log('  결과: ' + s.detail);
  }
}
