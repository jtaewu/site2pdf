// 시스템 Chrome을 playwright-core로 구동. 범용 렌더링 대기·안전한 컨텍스트 생성 PoC.
import { chromium } from 'playwright-core';

/**
 * 이 PC의 Chrome/Edge는 조직 정책(ExtensionInstallForcelist)으로 확장이 강제 설치되어 있어
 * Playwright 기본 인자 --disable-extensions 를 주면 브라우저가 즉시 exit 1 한다(보고서 F-01).
 * PoC에서는 해당 인자만 제외한다. 운영 실행은 정책 없는 전용 Chromium/컨테이너를 권장.
 */
export const launch = (args = []) => chromium.launch({
  channel: process.env.SITE2PDF_CHANNEL || 'chrome',
  headless: true,
  args,
  ignoreDefaultArgs: ['--disable-extensions'],
});

/** 허용 origin 외 모든 요청을 차단하는 컨텍스트. blocked 배열에 차단 내역을 누적 */
export async function safeContext(browser, allowedOrigins, { blocked = [], serviceWorkers = 'block', guardWebSocket = true } = {}) {
  const ctx = await browser.newContext({ serviceWorkers, acceptDownloads: false, viewport: { width: 794, height: 1123 } });
  const allowed = url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return true;
    try { return allowedOrigins.includes(new URL(url).origin); } catch { return false; }
  };
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (allowed(url)) return route.continue();
    blocked.push({ type: route.request().resourceType(), url });
    return route.abort('blockedbyclient');
  });
  if (guardWebSocket) {
    // context.route는 WebSocket을 가로채지 않으므로 별도 차단
    await ctx.routeWebSocket(/.*/, ws => { blocked.push({ type: 'websocket', url: ws.url() }); ws.close(); });
  }
  ctx.on('page', p => p.opener().then(o => { if (o) { blocked.push({ type: 'popup', url: p.url() }); p.close().catch(() => {}); } }));
  return ctx;
}

/** 사이트별 마커 없이 쓰는 범용 대기: load → 네트워크 유휴 → DOM 변경이 quietMs 동안 없음 → 폰트/이미지 완료. 상한 timeoutMs */
export async function waitForStable(page, { timeoutMs = 10000, quietMs = 500 } = {}) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  await page.waitForLoadState('load', { timeout: left() });
  await page.waitForLoadState('networkidle', { timeout: left() }).catch(() => {});
  const stable = await page.evaluate(({ quietMs, max }) => new Promise(resolve => {
    let t;
    const done = ok => { obs.disconnect(); clearTimeout(t); clearTimeout(cap); resolve(ok); };
    const obs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => done(true), quietMs); });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    t = setTimeout(() => done(true), quietMs);
    const cap = setTimeout(() => done(false), max);
  }), { quietMs, max: left() });
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))])).catch(() => {});
  return { stable, elapsedMs: Date.now() - t0 };
}
