// 범위 제한 BFS 탐색 (FR-03, FR-04, ADR-002). 네트워크·브라우저는 PageLoader로 주입한다.
import type { CrawlConfig } from '../config/schema.ts';
import { normalizeUrl, scopeExclusionReason, type Scope } from '../fetch-policy/url.ts';
import type { PageLoader } from '../browser/page-loader.ts';
import type { SelectionResult } from './selection.ts';
import { silentLogger, type Logger } from '../report/logger.ts';
import { isTransientFailure } from './retry.ts';

export type PageRecord = {
  order: number;
  url: string;
  depth: number;
  /** 처음 발견한 부모 페이지 (시작 페이지는 null) */
  foundOn: string | null;
  status: 'ok' | 'failed';
  httpStatus: number;
  finalUrl: string;
  redirectChain: string[];
  title: string;
  textLength: number;
  failure?: string;
  selected: boolean;
  selectionReason?: string;
  elapsedMs: number;
  /** 시도 횟수 (재시도 포함) */
  attempts: number;
};

export type ExcludedRecord = { url: string; reason: string; foundOn: string | null };

export type StopReason = 'exhausted' | 'max-pages' | 'max-total-time' | 'access-denied' | 'start-failed';

export type CrawlResult = {
  pages: PageRecord[];
  excluded: ExcludedRecord[];
  stopReason: StopReason;
  /** 한도로 방문하지 못한 URL 수 (excluded에 not-visited로도 기록) */
  notVisited: number;
  requests: number;
  effectiveDelayMs: number;
  elapsedMs: number;
};

export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export type CrawlInput = {
  startUrl: string;
  scope: Scope;
  crawl: CrawlConfig;
  load: PageLoader;
  select: (url: string) => SelectionResult;
  /** robots 판정 (없으면 모두 허용) */
  robotsAllows?: (url: string) => boolean;
  /** robots Crawl-delay(초). minDelayMs보다 길면 이를 따른다 */
  robotsDelaySec?: number;
  clock?: Clock;
  log?: Logger;
};

/** 접근 거부·요청 제한 응답은 우회하지 않고 전체 탐색을 멈춘다 (SC-11) */
const ACCESS_DENIED = new Set([401, 403, 407, 429]);

export async function crawl(input: CrawlInput): Promise<CrawlResult> {
  const clock = input.clock ?? realClock;
  const log = input.log ?? silentLogger;
  const { crawl: limits, scope } = input;
  const query = limits.query;
  const delay = Math.max(limits.minDelayMs, Math.round((input.robotsDelaySec ?? 0) * 1000));
  const started = clock.now();

  const pages: PageRecord[] = [];
  const excluded: ExcludedRecord[] = [];
  const excludedSeen = new Set<string>();
  const exclude = (url: string, reason: string, foundOn: string | null) => {
    if (excludedSeen.has(url)) return;
    excludedSeen.add(url);
    excluded.push({ url, reason, foundOn });
  };

  const start = normalizeUrl(input.startUrl, input.startUrl, query);
  const queue: Array<{ url: string; depth: number; foundOn: string | null }> = [];
  const seen = new Set<string>();
  let stopReason: StopReason = 'exhausted';
  let requests = 0;
  let lastRequestAt = -Infinity;

  const enqueue = (url: string, depth: number, foundOn: string | null) => {
    if (seen.has(url)) return;
    const reason = scopeExclusionReason(url, scope);
    if (reason) return exclude(url, reason, foundOn);
    if (depth > limits.maxDepth) return exclude(url, 'max-depth', foundOn);
    if (input.robotsAllows && !input.robotsAllows(url)) return exclude(url, 'robots-disallow', foundOn);
    seen.add(url);
    queue.push({ url, depth, foundOn });
  };

  if (!start) {
    return { pages, excluded: [{ url: input.startUrl, reason: 'invalid-url', foundOn: null }], stopReason: 'start-failed', notVisited: 0, requests, effectiveDelayMs: delay, elapsedMs: 0 };
  }
  enqueue(start, 0, null);
  if (queue.length === 0) stopReason = 'start-failed';

  while (queue.length > 0) {
    if (pages.length >= limits.maxPages) {
      stopReason = 'max-pages';
      break;
    }
    if (clock.now() - started >= limits.maxTotalMs) {
      stopReason = 'max-total-time';
      break;
    }
    const item = queue.shift()!;
    const wait = lastRequestAt + delay - clock.now();
    if (wait > 0) await clock.sleep(wait);
    lastRequestAt = clock.now();
    requests++;
    log.debug(`방문 ${pages.length + 1}: ${item.url}`);
    let r = await input.load(item.url);
    let attempts = 1;
    // 일시적 실패만 제한 횟수 재시도 (요청 간격은 그대로 지킨다)
    while (isTransientFailure(r.failure) && attempts <= (limits.retries ?? 0)) {
      log.warn(`일시적 실패(${r.failure}) → 재시도 ${attempts}/${limits.retries}: ${item.url}`);
      await clock.sleep(Math.max(delay, 1000));
      lastRequestAt = clock.now();
      requests++;
      attempts++;
      r = await input.load(item.url);
    }

    const rec: PageRecord = {
      order: pages.length + 1,
      url: item.url,
      depth: item.depth,
      foundOn: item.foundOn,
      status: 'ok',
      httpStatus: r.httpStatus,
      finalUrl: r.finalUrl,
      redirectChain: r.redirectChain,
      title: r.title,
      textLength: r.textLength,
      selected: false,
      elapsedMs: r.elapsedMs,
      attempts,
    };

    // 리다이렉트 후 최종 URL 재검증 (T-04, SC-08)
    const finalNorm = normalizeUrl(r.finalUrl, r.finalUrl, query);
    const finalOut = finalNorm ? scopeExclusionReason(finalNorm, scope) : 'invalid-url';
    let failure = r.failure;
    if (!failure && finalOut) failure = `redirect-out-of-scope:${finalOut}`;
    if (failure) {
      rec.status = 'failed';
      rec.failure = failure;
      pages.push(rec);
      log.warn(`실패 ${item.url}: ${failure}`);
      if (r.failure?.startsWith('http-') && ACCESS_DENIED.has(r.httpStatus)) {
        stopReason = 'access-denied';
        break;
      }
      continue;
    }
    // 리다이렉트로 이미 방문한 URL에 도착했으면 중복으로 처리
    if (finalNorm && finalNorm !== item.url) {
      if (seen.has(finalNorm) && pages.some((p) => p.url === finalNorm)) {
        exclude(item.url, `duplicate-of:${finalNorm}`, item.foundOn);
        continue;
      }
      seen.add(finalNorm);
    }
    const sel = input.select(item.url);
    rec.selected = sel.selected;
    if (!sel.selected) rec.selectionReason = sel.reason;
    pages.push(rec);

    for (const raw of r.links) {
      if (/^(javascript|mailto|tel|data):/i.test(raw)) {
        exclude(raw, `scheme:${raw.split(':')[0]!.toLowerCase()}`, item.url);
        continue;
      }
      const n = normalizeUrl(raw, r.finalUrl, query);
      if (!n) {
        exclude(raw, 'invalid-url', item.url);
        continue;
      }
      enqueue(n, item.depth + 1, item.url);
    }
  }

  if (stopReason === 'exhausted' && pages.length === 1 && pages[0]!.status === 'failed') stopReason = 'start-failed';
  for (const q of queue) exclude(q.url, `not-visited:${stopReason}`, q.foundOn);
  return { pages, excluded, stopReason, notVisited: queue.length, requests, effectiveDelayMs: delay, elapsedMs: clock.now() - started };
}
