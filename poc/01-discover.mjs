// PoC 1: 탐색 방식 비교 — (A) HTTP 응답 HTML 파싱 vs (B) 브라우저 DOM 링크 수집, 정적/SPA fixture 각각
import fs from 'node:fs';
import { startFixtureServer } from './lib/server.mjs';
import { normalizeUrl, scopeCheck } from './lib/policy.mjs';
import { launch, safeContext, waitForStable } from './lib/browser.mjs';

const OUT = '../output/poc';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 범용 BFS. extract(url) → { status, finalUrl, title, links[] } */
export async function discover({ startUrl, scope, maxPages, maxDepth, minDelayMs = 0, maxTotalMs = 60000, query = 'keep', extract }) {
  const t0 = Date.now();
  const start = normalizeUrl(startUrl, startUrl, { query });
  const queue = [{ url: start, depth: 0, from: null }];
  const seen = new Set([start]);
  const pages = [], excluded = [];
  const exclude = (url, reason, from) => { if (!excluded.some(e => e.url === url)) excluded.push({ url, reason, from }); };
  let lastReq = 0, stopReason = 'exhausted', requests = 0;
  while (queue.length) {
    if (pages.length >= maxPages) { stopReason = 'maxPages'; break; }
    if (Date.now() - t0 > maxTotalMs) { stopReason = 'maxTotalMs'; break; }
    const { url, depth, from } = queue.shift();
    const wait = lastReq + minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now(); requests++;
    let r;
    try { r = await extract(url); } catch (e) { pages.push({ order: pages.length + 1, url, depth, from, status: 'failed', error: e.message.split('\n')[0] }); continue; }
    // 리다이렉트 후 최종 URL 재검증
    const finalNorm = normalizeUrl(r.finalUrl, r.finalUrl, { query });
    const finalReason = scopeCheck(finalNorm, scope);
    if (finalReason) { pages.push({ order: pages.length + 1, url, depth, from, status: 'blocked-after-redirect', finalUrl: r.finalUrl, reason: finalReason }); continue; }
    pages.push({ order: pages.length + 1, url, depth, from, status: r.status, title: r.title, linkCount: r.links.length, ...(r.note ? { note: r.note } : {}) });
    for (const raw of r.links) {
      if (/^(mailto|tel|javascript):/i.test(raw)) { exclude(raw, 'scheme:' + raw.split(':')[0], url); continue; }
      const n = normalizeUrl(raw, r.finalUrl, { query });
      if (!n) { exclude(raw, 'invalid-url', url); continue; }
      const reason = scopeCheck(n, scope);
      if (reason) { exclude(n, reason, url); continue; }
      if (seen.has(n)) continue;
      if (depth + 1 > maxDepth) { exclude(n, 'maxDepth', url); continue; }
      seen.add(n);
      queue.push({ url: n, depth: depth + 1, from: url });
    }
  }
  if (!queue.length && stopReason !== 'maxPages') stopReason = 'exhausted';
  return { pages, excluded, stopReason, pending: queue.length, requests, elapsedMs: Date.now() - t0 };
}

// (A) HTTP + 정규식 파싱(PoC 한정, 실제 구현은 HTML 파서 사용). 리다이렉트는 수동 처리하여 매 hop 재검증 가능하게 함
const httpExtract = async url => {
  const res = await fetch(url, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) return { status: res.status, finalUrl: new URL(res.headers.get('location'), url).href, title: null, links: [] };
  const html = await res.text();
  const links = [...html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  const title = (/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || null;
  return { status: res.status, finalUrl: url, title, links };
};

// (B) 브라우저 DOM
const browserExtractor = (ctx, { timeoutMs = 5000 } = {}) => async url => {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
    const st = await waitForStable(page, { timeoutMs });
    const links = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href').trim().toLowerCase().startsWith('javascript:') ? a.getAttribute('href') : a.href));
    const textLen = await page.evaluate(() => document.body.innerText.trim().length);
    return { status: resp?.status() ?? 0, finalUrl: page.url(), title: await page.title(), links, note: `stable=${st.stable} ${st.elapsedMs}ms textLen=${textLen}` };
  } finally { await page.close(); }
};

export async function run() {
  const results = {};
  // ---- 정적 사이트 ----
  let originRef = '';
  const stat = await startFixtureServer({
    root: '../fixtures/static-site',
    vars: { NEXT: u => String((+u.searchParams.get('page') || 0) + 1), 'http://SITE': () => originRef },
    routes: { '/docs/moved': (req, res) => { res.writeHead(302, { location: 'http://127.0.0.2:9/internal' }); res.end(); } },
  });
  originRef = stat.origin;
  const scope = { allowedOrigins: [stat.origin], pathPrefixes: ['/docs'], denyPatterns: ['/admin', '/logout', '/private/', '?download='] };
  const base = { startUrl: stat.origin + '/docs/index.html', scope, maxPages: 30, maxDepth: 3, minDelayMs: 50 };

  results.static_http_keepQuery = await discover({ ...base, extract: httpExtract, query: 'keep' });
  stat.log.length = 0;
  results.static_http_dropQuery = await discover({ ...base, extract: httpExtract, query: 'drop' });
  results.static_http_dropQuery.serverRequests = stat.log.length;

  // 리다이렉트 이탈(허용 경로 → 다른 호스트) 확인: 시작 URL 자체가 리다이렉트
  results.static_redirect = await discover({ ...base, startUrl: stat.origin + '/docs/moved', extract: httpExtract });

  // sitemap.xml 비교
  const sm = await (await fetch(stat.origin + '/sitemap.xml')).text();
  results.static_sitemap = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);

  const browser = await launch();
  const blocked = [];
  const ctx = await safeContext(browser, [stat.origin], { blocked });
  results.static_browser_dropQuery = await discover({ ...base, extract: browserExtractor(ctx), query: 'drop' });
  results.static_browser_blocked = blocked.splice(0);
  await ctx.close();
  await stat.close();

  // ---- SPA ----
  const spa = await startFixtureServer({ root: '../fixtures/spa-site', spaPrefix: '/app/' });
  const spaScope = { allowedOrigins: [spa.origin], pathPrefixes: ['/app'], denyPatterns: [] };
  const spaBase = { startUrl: spa.origin + '/app/', scope: spaScope, maxPages: 20, maxDepth: 3, minDelayMs: 50 };
  results.spa_http = await discover({ ...spaBase, extract: httpExtract });
  const ctx2 = await safeContext(browser, [spa.origin], { blocked });
  results.spa_browser = await discover({ ...spaBase, extract: browserExtractor(ctx2, { timeoutMs: 5000 }) });
  results.spa_browser_blocked = blocked.splice(0);
  await ctx2.close();
  await browser.close();
  await spa.close();

  // origin 표기를 치환해 결과를 안정적으로 저장
  const json = JSON.stringify(results, null, 2).split(stat.origin).join('{STATIC}').split(spa.origin).join('{SPA}');
  fs.writeFileSync(`${OUT}/discover.json`, json);
  return JSON.parse(json);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('01-discover.mjs')) {
  const r = await run();
  for (const [k, v] of Object.entries(r)) {
    if (Array.isArray(v)) { console.log(`\n## ${k}: ${v.length}건`, v.slice(0, 6)); continue; }
    console.log(`\n## ${k}  stop=${v.stopReason} pages=${v.pages.length} excluded=${v.excluded.length} requests=${v.requests} ${v.elapsedMs}ms`);
    v.pages.forEach(p => console.log(`  ${p.order}. [d${p.depth}] ${p.status} ${p.url} | ${p.title ?? ''} ${p.note ?? ''} ${p.reason ?? ''}`));
    v.excluded.forEach(e => console.log(`  - 제외 ${e.reason}: ${e.url}`));
  }
}
