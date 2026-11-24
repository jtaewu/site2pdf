// 가짜 사이트 그래프와 가짜 시계로 탐색 규칙을 검증한다 (네트워크·브라우저 없음)
import { describe, expect, it } from 'vitest';
import { crawl, type Clock, type CrawlInput } from '../../src/discover/crawler.ts';
import { crawlSchema } from '../../src/config/schema.ts';
import { createSelector } from '../../src/discover/selection.ts';
import type { LoadResult } from '../../src/browser/page-loader.ts';

const O = 'https://site.test';
type FakePage = { links?: string[]; status?: number; redirectTo?: string; failure?: string };

function fakeSite(pages: Record<string, FakePage | ((url: URL) => FakePage)>) {
  const visits: string[] = [];
  const load = async (url: string): Promise<LoadResult> => {
    visits.push(url);
    const u = new URL(url);
    const def = pages[u.pathname];
    const p = typeof def === 'function' ? def(u) : def;
    if (!p) return { httpStatus: 404, finalUrl: url, redirectChain: [], title: '', links: [], textLength: 0, failure: 'http-404', elapsedMs: 1 };
    const finalUrl = p.redirectTo ?? url;
    const status = p.status ?? 200;
    return {
      httpStatus: status,
      finalUrl,
      redirectChain: p.redirectTo ? [url] : [],
      title: u.pathname,
      links: p.links ?? [],
      textLength: 100,
      failure: p.failure ?? (status >= 400 ? `http-${status}` : undefined),
      elapsedMs: 1,
    };
  };
  return { load, visits };
}

function fakeClock(): Clock & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return { slept, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } };
}

const base = (load: CrawlInput['load'], over: Partial<CrawlInput> = {}, crawlOver: Record<string, unknown> = {}): CrawlInput => ({
  startUrl: `${O}/docs/`,
  scope: { allowedOrigins: [O], pathPrefixes: ['/docs'], denyPatterns: ['/logout'] },
  crawl: crawlSchema.parse({ minDelayMs: 0, ...crawlOver }),
  load,
  select: createSelector({ include: [], exclude: [] }),
  clock: fakeClock(),
  ...over,
});

describe('탐색 기본 동작 (SC-02)', () => {
  it('BFS 순서·깊이·발견 부모를 기록하고 범위 밖 링크를 사유와 함께 제외한다', async () => {
    const site = fakeSite({
      '/docs/': { links: ['a.html', 'b.html', 'https://ext.test/x', '/logout', 'mailto:m@x', '/blog/'] },
      '/docs/a.html': { links: ['c.html'] },
      '/docs/b.html': {},
      '/docs/c.html': {},
    });
    const r = await crawl(base(site.load));
    expect(r.pages.map((p) => [p.order, p.depth, new URL(p.url).pathname])).toEqual([
      [1, 0, '/docs/'], [2, 1, '/docs/a.html'], [3, 1, '/docs/b.html'], [4, 2, '/docs/c.html'],
    ]);
    expect(r.pages[3]!.foundOn).toBe(`${O}/docs/a.html`);
    expect(Object.fromEntries(r.excluded.map((e) => [e.url, e.reason]))).toEqual({
      'https://ext.test/x': 'origin-out-of-scope',
      [`${O}/logout`]: 'path-out-of-scope',
      'mailto:m@x': 'scheme:mailto',
      [`${O}/blog/`]: 'path-out-of-scope',
    });
    expect(r.stopReason).toBe('exhausted');
  });
});

describe('T-07 순환·중복·쿼리 조합', () => {
  it('순환 링크와 fragment/추적 파라미터 변형은 한 번만 방문한다', async () => {
    const site = fakeSite({
      '/docs/': { links: ['a.html', 'a.html#top', 'a.html?utm_source=x', '/docs/'] },
      '/docs/a.html': { links: ['/docs/', '../docs/a.html'] },
    });
    const r = await crawl(base(site.load));
    expect(site.visits).toEqual([`${O}/docs/`, `${O}/docs/a.html`]);
    expect(r.pages).toHaveLength(2);
  });

  it('쿼리 무한 조합: drop 정책이면 1페이지로 합쳐진다', async () => {
    const pager = (u: URL): FakePage => ({ links: [`list?page=${Number(u.searchParams.get('page') ?? 0) + 1}`] });
    const site = fakeSite({ '/docs/': { links: ['list?page=1'] }, '/docs/list': pager });
    const r = await crawl(base(site.load));
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/docs/`, `${O}/docs/list`]);
  });

  it('쿼리 무한 조합: keep 정책이어도 maxPages에서 멈추고 미방문을 기록한다', async () => {
    const pager = (u: URL): FakePage => ({ links: [`list?page=${Number(u.searchParams.get('page') ?? 0) + 1}`] });
    const site = fakeSite({ '/docs/': { links: ['list?page=1'] }, '/docs/list': pager });
    const r = await crawl(base(site.load, {}, { maxPages: 5, maxDepth: 20, query: { policy: 'keep', keepParams: [] } }));
    expect(r.pages).toHaveLength(5);
    expect(r.stopReason).toBe('max-pages');
    expect(r.notVisited).toBe(1);
    expect(r.excluded.at(-1)?.reason).toBe('not-visited:max-pages');
  });

  it('리다이렉트로 이미 방문한 페이지에 도착하면 중복으로 제외한다', async () => {
    const site = fakeSite({ '/docs/': { links: ['a.html', 'old.html'] }, '/docs/a.html': {}, '/docs/old.html': { redirectTo: `${O}/docs/a.html` } });
    const r = await crawl(base(site.load));
    expect(r.pages.map((p) => p.url)).toEqual([`${O}/docs/`, `${O}/docs/a.html`]);
    expect(r.excluded).toContainEqual({ url: `${O}/docs/old.html`, reason: `duplicate-of:${O}/docs/a.html`, foundOn: `${O}/docs/` });
  });
});

describe('T-09 제한값 준수', () => {
  const chain = fakeSite({ '/docs/': { links: ['1'] }, '/docs/1': { links: ['2'] }, '/docs/2': { links: ['3'] }, '/docs/3': { links: ['4'] }, '/docs/4': {} });

  it('maxDepth: 깊이 초과 링크는 방문하지 않고 max-depth로 기록', async () => {
    const r = await crawl(base(chain.load, {}, { maxDepth: 2 }));
    expect(r.pages.map((p) => p.depth)).toEqual([0, 1, 2]);
    expect(r.excluded).toContainEqual({ url: `${O}/docs/3`, reason: 'max-depth', foundOn: `${O}/docs/2` });
  });

  it('maxPages: 방문 수 상한', async () => {
    const r = await crawl(base(chain.load, {}, { maxPages: 2 }));
    expect(r.pages).toHaveLength(2);
    expect(r.stopReason).toBe('max-pages');
  });

  it('minDelayMs: 요청 사이 간격을 지킨다 (첫 요청은 대기 없음)', async () => {
    const clock = fakeClock();
    const r = await crawl(base(chain.load, { clock }, { minDelayMs: 1000 }));
    expect(r.requests).toBe(5);
    expect(clock.slept).toEqual([1000, 1000, 1000, 1000]);
  });

  it('robots Crawl-delay가 더 길면 그 값을 따른다', async () => {
    const clock = fakeClock();
    const r = await crawl(base(chain.load, { clock, robotsDelaySec: 3 }, { minDelayMs: 1000 }));
    expect(r.effectiveDelayMs).toBe(3000);
    expect(clock.slept[0]).toBe(3000);
  });

  it('maxTotalMs: 전체 시간 상한', async () => {
    const clock = fakeClock();
    const r = await crawl(base(chain.load, { clock }, { minDelayMs: 1000, maxTotalMs: 2500 }));
    expect(r.stopReason).toBe('max-total-time');
    expect(r.pages.length).toBeLessThan(5);
  });
});

describe('T-08 robots·접근 거부', () => {
  it('robots가 금지한 URL은 요청하지 않고 robots-disallow로 기록', async () => {
    const site = fakeSite({ '/docs/': { links: ['open.html', 'secret/x.html'] }, '/docs/open.html': {}, '/docs/secret/x.html': {} });
    const r = await crawl(base(site.load, { robotsAllows: (u) => !u.includes('/secret/') }));
    expect(site.visits).not.toContain(`${O}/docs/secret/x.html`);
    expect(r.excluded).toContainEqual({ url: `${O}/docs/secret/x.html`, reason: 'robots-disallow', foundOn: `${O}/docs/` });
  });

  it.each([401, 403, 429])('HTTP %i 응답이면 우회하지 않고 전체 탐색 중지', async (status) => {
    const site = fakeSite({ '/docs/': { links: ['a', 'b', 'c'] }, '/docs/a': { status }, '/docs/b': {}, '/docs/c': {} });
    const r = await crawl(base(site.load));
    expect(r.stopReason).toBe('access-denied');
    expect(site.visits).toHaveLength(2);
    expect(r.excluded.filter((e) => e.reason === 'not-visited:access-denied')).toHaveLength(2);
  });

  it('이그레스 프록시 차단(egress-blocked)은 사이트 접근 거부로 보지 않는다', async () => {
    const site = fakeSite({ '/docs/': { links: ['a', 'b'] }, '/docs/a': { status: 403, failure: 'egress-blocked:host-not-allowed' }, '/docs/b': {} });
    const r = await crawl(base(site.load));
    expect(r.stopReason).toBe('exhausted');
    expect(r.pages.map((p) => p.status)).toEqual(['ok', 'failed', 'ok']);
  });
});

describe('T-04 리다이렉트 이탈 / SC-12 부분 실패', () => {
  it('최종 URL이 범위 밖이면 실패로 기록하고 그 페이지 링크는 따라가지 않는다', async () => {
    const site = fakeSite({ '/docs/': { links: ['go'] }, '/docs/go': { redirectTo: 'https://evil.test/x', links: ['/docs/hidden'] }, '/docs/hidden': {} });
    const r = await crawl(base(site.load));
    expect(r.pages[1]).toMatchObject({ status: 'failed', failure: 'redirect-out-of-scope:origin-out-of-scope' });
    expect(site.visits).not.toContain(`${O}/docs/hidden`);
  });

  it('일부 실패는 실패로 남고 성공으로 바뀌지 않는다', async () => {
    const site = fakeSite({ '/docs/': { links: ['a', 'missing', 'slow'] }, '/docs/a': {}, '/docs/slow': { failure: 'content-too-short' } });
    const r = await crawl(base(site.load));
    expect(r.pages.map((p) => [new URL(p.url).pathname, p.status, p.failure ?? ''])).toEqual([
      ['/docs/', 'ok', ''], ['/docs/a', 'ok', ''], ['/docs/missing', 'failed', 'http-404'], ['/docs/slow', 'failed', 'content-too-short'],
    ]);
  });

  it('시작 페이지만 실패하면 start-failed', async () => {
    const r = await crawl(base(fakeSite({}).load));
    expect(r.stopReason).toBe('start-failed');
  });
});

describe('T-10 선택 제외', () => {
  it('제외 패턴 페이지는 탐색은 하되 selected=false와 사유를 남긴다', async () => {
    const site = fakeSite({ '/docs/': { links: ['api/a', 'internal/x', 'guide/g'] }, '/docs/api/a': {}, '/docs/internal/x': {}, '/docs/guide/g': {} });
    const r = await crawl(base(site.load, { select: createSelector({ include: ['/docs/**'], exclude: ['/docs/internal/**'] }) }));
    const sel = Object.fromEntries(r.pages.map((p) => [new URL(p.url).pathname, p.selectionReason ?? 'selected']));
    expect(sel).toEqual({ '/docs/': 'selected', '/docs/api/a': 'selected', '/docs/internal/x': 'selection-exclude:/docs/internal/**', '/docs/guide/g': 'selected' });
  });

  it('include가 있으면 매칭되지 않는 페이지는 selection-not-included', () => {
    const s = createSelector({ include: ['/docs/api/**'], exclude: [] });
    expect(s(`${O}/docs/guide/x`)).toEqual({ selected: false, reason: 'selection-not-included' });
    expect(s(`${O}/docs/api/x`)).toEqual({ selected: true });
  });
});
