// 안전한 브라우저 컨텍스트 (ADR-004 L-B). 프록시(L-C)와 함께 쓴다.
import type { Browser, BrowserContext } from 'playwright';

export type BlockedRequest = { type: string; url: string };

export type SafeContextOptions = {
  /** 최상위 문서 이동과 하위 리소스를 허용할 origin (탐색 범위) */
  pageOrigins: string[];
  /** 하위 리소스만 추가 허용할 origin (D-09) */
  resourceOrigins?: string[];
  /** 테스트 전용(자체 서명 fixture 인증서) */
  ignoreHTTPSErrors?: boolean;
};

export type SafeContext = { context: BrowserContext; blocked: BlockedRequest[] };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function createSafeContext(browser: Browser, opts: SafeContextOptions): Promise<SafeContext> {
  const pageOrigins = new Set(opts.pageOrigins);
  const resourceOrigins = new Set([...opts.pageOrigins, ...(opts.resourceOrigins ?? [])]);
  const blocked: BlockedRequest[] = [];
  const context = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: true,
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    ignoreHTTPSErrors: opts.ignoreHTTPSErrors ?? false,
  });

  await context.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    const origin = originOf(url);
    let isDocument = false;
    try {
      // 최상위 문서 이동만 탐색 범위로 판정, iframe 문서는 하위 리소스로 취급
      isDocument = req.isNavigationRequest() && req.frame().parentFrame() === null;
    } catch {
      // frame이 없는 요청(워커 등)은 하위 리소스로 취급
    }
    const ok = origin !== null && (isDocument ? pageOrigins.has(origin) : resourceOrigins.has(origin));
    if (ok) return route.continue();
    blocked.push({ type: isDocument ? 'navigation' : req.resourceType(), url });
    return route.abort('blockedbyclient');
  });

  // context.route는 WebSocket을 가로채지 않는다 (PoC L1)
  await context.routeWebSocket(/.*/, (ws) => {
    blocked.push({ type: 'websocket', url: ws.url() });
    void ws.close();
  });

  // 페이지가 연 팝업은 즉시 닫는다
  context.on('page', (p) => {
    void p.opener().then((opener) => {
      if (opener) {
        blocked.push({ type: 'popup', url: p.url() });
        void p.close().catch(() => {});
      }
    });
  });

  return { context, blocked };
}
