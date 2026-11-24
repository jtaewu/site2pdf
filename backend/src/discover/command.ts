// discover 명령: 범위 안 페이지 목록을 만들고 discovered.json에 기록한다 (SC-02, SC-03, FR-03~05, FR-09 일부)
import { assertSafeOutputDir } from '../config/load.ts';
import type { Config } from '../config/schema.ts';
import { ExitCode, type ExitCodeValue } from '../errors.ts';
import { openSession, type Session, type SessionOptions } from '../session.ts';
import { crawl, type CrawlResult } from './crawler.ts';
import { createSelector } from './selection.ts';
import { TOOL, newRunId, robotsSummary, summarizeBlocked, summarizeEgressDenied, writeJson } from '../report/summary.ts';
import { silentLogger, type Logger } from '../report/logger.ts';

export type DiscoverOutcome = { result: CrawlResult | null; exitCode: ExitCodeValue; message: string };

/** robots 확인 → 탐색 → 결과 판정. 세션은 호출자가 관리한다 */
export async function discoverInSession(session: Session, config: Config, log: Logger = silentLogger): Promise<DiscoverOutcome> {
  const robots = session.robots;
  if (robots.state === 'unavailable') {
    return { result: null, exitCode: ExitCode.INPUT, message: `robots.txt를 확인할 수 없어 수집을 중지합니다(${robots.reason}). 사이트 담당자 확인 후 다시 실행하세요.` };
  }
  if (robots.state === 'present' && !robots.isAllowed(session.startUrl)) {
    return { result: null, exitCode: ExitCode.INPUT, message: 'robots.txt가 시작 URL 수집을 금지합니다. 우회하지 않고 중지합니다.' };
  }
  const result = await crawl({
    startUrl: session.startUrl,
    scope: session.scope,
    crawl: config.crawl,
    load: session.load,
    select: createSelector(config.selection),
    robotsAllows: robots.state === 'present' ? robots.isAllowed : undefined,
    robotsDelaySec: robots.state === 'present' ? robots.crawlDelaySec : undefined,
    log,
  });
  const failed = result.pages.filter((p) => p.status === 'failed');
  let exitCode: ExitCodeValue = ExitCode.OK;
  let message: string;
  if (result.stopReason === 'access-denied') {
    exitCode = ExitCode.INPUT;
    message = '접근 거부(401/403/407/429) 응답을 받아 우회하지 않고 중지했습니다. 승인된 접근 경로나 로컬 빌드를 확인하세요.';
  } else if (result.stopReason === 'start-failed') {
    const f = result.pages[0]?.failure ?? result.excluded[0]?.reason ?? 'unknown';
    exitCode = /^(redirect-out-of-scope|egress-blocked)/.test(f) ? ExitCode.SECURITY : ExitCode.RUN;
    message = `시작 페이지 처리 실패: ${f}`;
  } else if (failed.length > 0) {
    exitCode = ExitCode.RUN;
    message = `${result.pages.length}개 중 ${failed.length}개 페이지 실패. 전체 성공이 아닙니다.`;
  } else {
    message = `${result.pages.length}개 페이지 발견 (선택 ${result.pages.filter((p) => p.selected).length}개).`;
  }
  if (result.stopReason === 'max-pages' || result.stopReason === 'max-total-time') {
    message += ` 한도(${result.stopReason})에 도달해 ${result.notVisited}개 URL은 방문하지 않았습니다.`;
  }
  return { result, exitCode, message };
}

export function toPath(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

export function sessionInput(config: Config, session: Session) {
  return config.mode === 'remote' ? { startUrl: config.startUrl } : { sourcePath: config.sourcePath, startPath: config.startPath, localOrigin: session.localOrigin };
}

/** discovered.json 내용 */
export function discoveredDocument(config: Config, configHash: string, session: Session, outcome: DiscoverOutcome, runId: string, createdAt: string) {
  const { result } = outcome;
  const pages = result?.pages ?? [];
  return {
    schemaVersion: 1,
    command: 'discover',
    tool: TOOL,
    runId,
    createdAt,
    finishedAt: new Date().toISOString(),
    exitCode: outcome.exitCode,
    message: outcome.message,
    mode: config.mode,
    input: sessionInput(config, session),
    configHash,
    config,
    robots: robotsSummary(session.robots),
    result: result && {
      stopReason: result.stopReason,
      notVisited: result.notVisited,
      requests: result.requests,
      effectiveDelayMs: result.effectiveDelayMs,
      elapsedMs: result.elapsedMs,
      counts: {
        pages: pages.length,
        ok: pages.filter((p) => p.status === 'ok').length,
        failed: pages.filter((p) => p.status === 'failed').length,
        selected: pages.filter((p) => p.selected).length,
        excluded: result.excluded.length,
      },
    },
    pages: pages.map((p) => ({ ...p, path: toPath(p.url) })),
    excluded: result?.excluded ?? [],
    blockedRequests: summarizeBlocked(session.blocked),
    egressDenied: summarizeEgressDenied(session.egress.decisions),
  };
}

export type DiscoverOutput = { file: string; exitCode: ExitCodeValue; result: CrawlResult | null; message: string };

export async function runDiscover(config: Config, configHash: string, outputDir: string, opts: SessionOptions = {}): Promise<DiscoverOutput> {
  const runId = newRunId();
  const createdAt = new Date().toISOString();
  assertSafeOutputDir(config, outputDir);
  const session = await openSession(config, opts);
  try {
    const outcome = await discoverInSession(session, config, opts.log);
    const file = writeJson(outputDir, 'discovered.json', discoveredDocument(config, configHash, session, outcome, runId, createdAt));
    return { file, ...outcome };
  } finally {
    await session.close();
  }
}
