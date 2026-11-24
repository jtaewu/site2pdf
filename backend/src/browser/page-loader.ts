// 페이지를 열어 렌더 완료를 기다리고, 실패 판정(D-14)과 링크 수집을 한다.
import type { BrowserContext, Page } from 'playwright';
import type { RenderConfig } from '../config/schema.ts';

export type LoadResult = {
  /** 최종 문서 HTTP 상태 (응답이 없으면 0) */
  httpStatus: number;
  finalUrl: string;
  /** 리다이렉트를 거친 경우 거쳐 온 URL 목록 (처음 → 마지막 직전) */
  redirectChain: string[];
  title: string;
  /** 문서 순서대로 수집한 링크 (mailto/javascript 등은 원문 그대로) */
  links: string[];
  textLength: number;
  /** 실패 사유. 성공이면 undefined */
  failure?: string;
  elapsedMs: number;
};

export type PageLoader = (url: string) => Promise<LoadResult>;

/** load → networkidle(최대) → DOM 변경이 quietMs 동안 없을 때까지, 전체 상한 timeoutMs */
async function waitForStable(page: Page, deadline: number, quietMs: number): Promise<boolean> {
  const left = () => Math.max(1, deadline - Date.now());
  await page.waitForLoadState('load', { timeout: left() });
  await page.waitForLoadState('networkidle', { timeout: left() }).catch(() => {});
  return page.evaluate(
    ({ quietMs, max }) =>
      new Promise<boolean>((resolve) => {
        let quiet: ReturnType<typeof setTimeout>;
        const finish = (ok: boolean) => {
          observer.disconnect();
          clearTimeout(quiet);
          clearTimeout(cap);
          resolve(ok);
        };
        const observer = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(() => finish(true), quietMs);
        });
        observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        quiet = setTimeout(() => finish(true), quietMs);
        const cap = setTimeout(() => finish(false), max);
      }),
    { quietMs, max: left() },
  );
}

export function createBrowserPageLoader(context: BrowserContext, render: RenderConfig, timeoutMs: number): PageLoader {
  return async (url) => {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const page = await context.newPage();
    const base = { httpStatus: 0, finalUrl: url, redirectChain: [] as string[], title: '', links: [] as string[], textLength: 0 };
    const done = (r: Partial<LoadResult>): LoadResult => ({ ...base, ...r, elapsedMs: Date.now() - started });
    try {
      let response;
      try {
        response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
      } catch (e) {
        return done({ failure: `navigation-error: ${(e as Error).message.split('\n')[0]}` });
      }
      if (!response) return done({ failure: 'no-response' });
      const chain: string[] = [];
      for (let r = response.request().redirectedFrom(); r; r = r.redirectedFrom()) chain.unshift(r.url());
      base.redirectChain = chain;
      base.httpStatus = response.status();
      base.finalUrl = response.url();
      // 이그레스 프록시가 막은 응답은 사이트의 접근 거부와 구분한다
      const egressBlock = response.headers()['x-site2pdf-blocked'];
      if (egressBlock) return done({ failure: `egress-blocked:${egressBlock}` });
      if (response.status() >= 400) return done({ failure: `http-${response.status()}` });

      const stable = await waitForStable(page, deadline, render.quietMs).catch(() => false);
      // 렌더 중 최상위 문서가 범위 밖으로 이동하면(차단되어 에러 페이지가 됨) 실패 처리 (ADR-004 후속)
      if (page.url().startsWith('chrome-error://')) return done({ failure: 'navigated-to-error-page' });
      base.finalUrl = page.url();
      if (render.readySelector) {
        const left = Math.max(1, deadline - Date.now());
        const found = await page.waitForSelector(render.readySelector, { state: 'attached', timeout: left }).then(() => true, () => false);
        if (!found) return done({ failure: 'ready-selector-not-found' });
      } else if (!stable) {
        return done({ failure: 'render-timeout' });
      }
      const info = await page.evaluate((contentSelector) => {
        const root = contentSelector ? document.querySelector(contentSelector) : document.body;
        const links = [...document.querySelectorAll('a[href]')].map((a) => {
          const raw = a.getAttribute('href')!.trim();
          return /^(javascript|mailto|tel|data):/i.test(raw) ? raw : (a as HTMLAnchorElement).href;
        });
        return { found: !!root, text: root ? (root as HTMLElement).innerText.trim().length : 0, links, title: document.title };
      }, render.contentSelector ?? null);
      base.title = info.title;
      base.links = info.links;
      base.textLength = info.text;
      if (!info.found) return done({ failure: 'content-selector-not-found' });
      if (info.text < render.minTextLength) return done({ failure: 'content-too-short' });
      return done({});
    } finally {
      await page.close().catch(() => {});
    }
  };
}
