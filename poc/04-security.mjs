// PoC 4: 브라우저 내 범위 이탈 요청 차단 검증 + URL/IP 정책 단위 확인
// sentinel 서버(허용 origin 밖)에 실제로 도달한 요청 수로 방어 수준을 측정한다. 모든 통신은 로컬 루프백 안에서만 발생.
import fs from 'node:fs';
import { startFixtureServer, startSentinel } from './lib/server.mjs';
import { launch, safeContext } from './lib/browser.mjs';
import { validateRemoteUrl, blockedIpReason, normalizeUrl } from './lib/policy.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function attack(browser, site, sentinel, level) {
  sentinel.hits.length = 0;
  const blocked = [];
  let ctx;
  if (level === 'L0-none') ctx = await browser.newContext();
  else if (level === 'L1-route-only') ctx = await safeContext(browser, [site.origin], { blocked, serviceWorkers: 'allow', guardWebSocket: false });
  else ctx = await safeContext(browser, [site.origin], { blocked }); // L2: route + SW block + WS 차단 + 팝업 닫기
  const page = await ctx.newPage();
  let navErr = null;
  try { await page.goto(site.origin + '/attack.html', { waitUntil: 'load', timeout: 8000 }); } catch (e) { navErr = e.message.split('\n')[0]; }
  await sleep(3500);
  const attempts = await page.evaluate(() => window.__attempts || []).catch(() => ['(페이지 이동으로 기록 소실)']);
  const finalUrl = page.url();
  // 서버측 302 리다이렉트로 범위 밖 이동 시도 (route는 리다이렉트 후속 요청을 다시 호출하지 않는다는 문서 동작 확인)
  const p2 = await ctx.newPage();
  let redirectResult;
  try { const r = await p2.goto(site.origin + '/redirect-out', { timeout: 5000 }); redirectResult = `status=${r?.status()} final=${p2.url()}`; }
  catch (e) { redirectResult = 'error: ' + e.message.split('\n')[0]; }
  await sleep(500);
  await ctx.close();
  return { level, sentinelHits: [...sentinel.hits].sort(), hitCount: sentinel.hits.length, blockedCount: blocked.length, blockedTypes: [...new Set(blocked.map(b => b.type))], attempts, finalUrl, navErr, redirectResult };
}

export async function run() {
  const sentinel = await startSentinel();
  const site = await startFixtureServer({
    root: '../fixtures/security-site',
    vars: { __SENTINEL__: sentinel.origin },
    routes: { '/redirect-out': (req, res) => { res.writeHead(302, { location: sentinel.origin + '/via-302' }); res.end(); } },
  });
  const browser = await launch();
  const levels = [];
  for (const lv of ['L0-none', 'L1-route-only', 'L2-route+sw+ws+popup']) levels.push(await attack(browser, site, sentinel, lv));
  await browser.close();

  // ---- 정책 함수 확인 (네트워크 없음) ----
  const urls = [
    'https://docs.example.com/guide', 'http://docs.example.com/', 'https://user:pw@docs.example.com/', 'https://docs.example.com:8443/',
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://017700000001/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:7f00:1]/', 'https://169.254.169.254/latest/meta-data/', 'https://[fd00::1]/', 'https://10.0.0.5/', 'https://100.64.1.1/',
    'https://localhost/', 'https://foo.localhost/', 'https://metadata.google.internal/', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://xn--80ak6aa92e.com/', 'https://docs.example.com./',
  ].map(u => ({ input: u, ...validateRemoteUrl(u) }));
  const ips = ['8.8.8.8', '1.1.1.1', '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.32.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2001:4860:4860::8888']
    .map(ip => ({ ip, blocked: blockedIpReason(ip) }));
  const norm = [
    ['https://a.com/docs/x?utm_source=1&b=2&a=1#frag', 'keep'], ['https://a.com/docs/x?page=3', 'drop'], ['HTTPS://A.COM:443/docs/./y/../x', 'keep'], ['https://a.com/docs/%7Euser', 'keep'],
  ].map(([u, q]) => ({ input: u, query: q, out: normalizeUrl(u, u, { query: q }) }));

  await site.close(); await sentinel.close();
  const res = JSON.parse(JSON.stringify({ levels, urls, ips, norm }).split(sentinel.origin).join('{SENTINEL}').split(site.origin).join('{SITE}'));
  fs.writeFileSync('../output/poc/security.json', JSON.stringify(res, null, 2));
  return res;
}

if (process.argv[1].endsWith('04-security.mjs')) {
  const r = await run();
  for (const l of r.levels) {
    console.log(`\n## ${l.level}: sentinel 도달 ${l.hitCount}건, 차단 ${l.blockedCount}건 (${l.blockedTypes.join(',')})`);
    console.log('  도달: ' + l.sentinelHits.join(' | '));
    console.log('  페이지 기록: ' + l.attempts.join(' | '));
    console.log(`  최종URL: ${l.finalUrl}  navErr=${l.navErr}`);
    console.log(`  302 리다이렉트: ${l.redirectResult}`);
  }
  console.log('\n## URL 검증'); r.urls.forEach(u => console.log(`  ${u.ok ? 'PASS ' : 'BLOCK'} ${u.input.padEnd(44)} ${u.reason ?? ''} ${u.url ?? ''}`));
  console.log('\n## IP 판정'); console.log('  ' + r.ips.map(i => `${i.ip}=${i.blocked ? 'X' : 'ok'}`).join('  '));
  console.log('\n## 정규화'); r.norm.forEach(n => console.log(`  [${n.query}] ${n.input} → ${n.out}`));
}
