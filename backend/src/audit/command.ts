// audit 명령: 수집 전에 입력·권한 신호·구조·외부 의존성을 최소 요청으로 진단한다 (SC-01, 01-source-audit)
// 요청: robots.txt(원격), 시작 페이지, sitemap.xml 각 1회
import type { Config } from '../config/schema.ts';
import { ExitCode, type ExitCodeValue } from '../errors.ts';
import { openSession, type SessionOptions } from '../session.ts';
import { normalizeUrl, scopeExclusionReason } from '../fetch-policy/url.ts';
import { TOOL, newRunId, robotsSummary, summarizeBlocked, summarizeEgressDenied, writeJson } from '../report/summary.ts';

export type AuditOutput = { file: string; exitCode: ExitCodeValue; findings: string[] };

export async function runAudit(config: Config, configHash: string, outputDir: string, opts: SessionOptions = {}): Promise<AuditOutput> {
  const runId = newRunId();
  const createdAt = new Date().toISOString();
  const session = await openSession(config, opts);
  try {
    const findings: string[] = [];
    let exitCode: ExitCodeValue = ExitCode.OK;
    const robots = session.robots;
    const query = config.crawl.query;

    if (robots.state === 'unavailable') {
      exitCode = ExitCode.INPUT;
      findings.push(`robots.txt 확인 실패(${robots.reason}): 수집 중지 대상`);
    } else if (robots.state === 'present' && !robots.isAllowed(session.startUrl)) {
      exitCode = ExitCode.INPUT;
      findings.push('robots.txt가 시작 URL 수집을 금지함');
    }

    const start = exitCode === ExitCode.OK ? await session.load(session.startUrl) : null;
    const linkStats = { total: 0, inScope: 0, byReason: {} as Record<string, number> };
    const inScope = new Set<string>();
    if (start) {
      if (start.redirectChain.length) findings.push(`시작 URL 리다이렉트 ${start.redirectChain.length}회 → ${start.finalUrl}`);
      const finalNorm = normalizeUrl(start.finalUrl, start.finalUrl, query);
      const finalOut = finalNorm ? scopeExclusionReason(finalNorm, session.scope) : 'invalid-url';
      if ([401, 403, 407, 429].includes(start.httpStatus)) {
        exitCode = ExitCode.INPUT;
        findings.push(`접근 거부 응답(HTTP ${start.httpStatus}): 우회하지 않음. 승인된 접근 경로나 로컬 빌드 필요`);
      } else if (finalOut && !start.failure) {
        exitCode = ExitCode.SECURITY;
        findings.push(`시작 페이지 최종 URL이 범위 밖(${finalOut})`);
      } else if (start.failure) {
        exitCode = ExitCode.RUN;
        findings.push(`시작 페이지 실패: ${start.failure}`);
      }
      for (const raw of start.links) {
        linkStats.total++;
        const n = /^(javascript|mailto|tel|data):/i.test(raw) ? null : normalizeUrl(raw, start.finalUrl, query);
        const reason = n ? scopeExclusionReason(n, session.scope) : `scheme-or-invalid`;
        if (!reason && n) inScope.add(n);
        else linkStats.byReason[reason ?? 'unknown'] = (linkStats.byReason[reason ?? 'unknown'] ?? 0) + 1;
      }
      linkStats.inScope = inScope.size;
      if (start.links.length === 0 && !start.failure) findings.push('시작 페이지에 링크가 없음: 메뉴가 링크 외 방식이거나 렌더링이 끝나지 않았을 수 있음(render.readySelector 검토)');
    }

    // sitemap.xml은 보조 정보 (ADR-002): 범위 안 URL 수만 센다
    let sitemap: { status: number | string; urls: number; inScope: number } | null = null;
    if (exitCode === ExitCode.OK) {
      const origin = session.scope.allowedOrigins[0]!;
      const r = await session.fetchText(`${origin}/sitemap.xml`);
      if ('error' in r) sitemap = { status: r.error, urls: 0, inScope: 0 };
      else {
        const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
        sitemap = { status: r.status, urls: locs.length, inScope: locs.filter((u) => !scopeExclusionReason(u, session.scope)).length };
      }
    }

    const blocked = summarizeBlocked(session.blocked);
    if (blocked.length) findings.push(`범위 밖 하위 리소스/요청 ${session.blocked.length}건 차단(외부 의존성 확인 필요)`);

    const data = {
      schemaVersion: 1,
      command: 'audit',
      tool: TOOL,
      runId,
      createdAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      mode: config.mode,
      input: config.mode === 'remote' ? { startUrl: config.startUrl } : { sourcePath: config.sourcePath, startPath: config.startPath, localOrigin: session.localOrigin },
      configHash,
      scope: session.scope,
      robots: robotsSummary(robots),
      startPage: start && {
        url: session.startUrl,
        httpStatus: start.httpStatus,
        finalUrl: start.finalUrl,
        redirectChain: start.redirectChain,
        title: start.title,
        textLength: start.textLength,
        failure: start.failure ?? null,
        elapsedMs: start.elapsedMs,
      },
      links: linkStats,
      sitemap,
      blockedRequests: blocked,
      egressDenied: summarizeEgressDenied(session.egress.decisions),
      findings,
      note: '권한·재배포 승인 여부는 자동으로 판정할 수 없습니다. 담당자 확인이 필요합니다.',
    };
    const file = writeJson(outputDir, 'audit.json', data);
    return { file, exitCode, findings };
  } finally {
    await session.close();
  }
}
