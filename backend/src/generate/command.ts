// generate 명령: 선택된 페이지를 렌더링해 페이지별 PDF와 통합 PDF, manifest.json, report.md를 만든다 (SC-04, FR-06~10, FR-13)
import { assertSafeOutputDir, safeJoin } from '../config/load.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/schema.ts';
import { ExitCode, type ExitCodeValue } from '../errors.ts';
import { openSession, type SessionOptions } from '../session.ts';
import { discoverInSession, discoveredDocument, sessionInput } from '../discover/command.ts';
import { candidatesFromCrawl, planPages, readDiscovered, type Plan } from './plan.ts';
import { renderPage } from '../render/render-page.ts';
import { isTransientFailure } from '../discover/retry.ts';
import { buildCombined, finalizePagePdf, type LinkPolicy, type PagePart } from '../pdf/assemble.ts';
import { pageFileName, slugify } from '../pdf/filename.ts';
import { matchesPathPrefix, normalizeUrl, scopeExclusionReason } from '../fetch-policy/url.ts';
import type { SensitiveHit } from '../report/sensitive.ts';
import { realClock, type Clock } from '../discover/crawler.ts';
import { TOOL, newRunId, robotsSummary, summarizeBlocked, summarizeEgressDenied, writeJson } from '../report/summary.ts';
import { silentLogger } from '../report/logger.ts';
import { writeReportMd } from '../report/report-md.ts';

export type GenerateOptions = SessionOptions & { discoveredPath?: string; clock?: Clock };

export type ManifestPage = {
  order: number;
  url: string;
  path: string;
  title: string;
  titleSource: 'h1' | 'title' | 'path';
  status: 'rendered' | 'failed';
  failure?: string;
  pdfFile: string | null;
  pdfPages: number;
  combinedStartPage: number | null;
  warnings: string[];
  qa: { coverage: number; overflow: Array<{ tag: string; right: number }>; tightTables: number; missingSamples: string[] } | null;
  blocked: string[];
  /** 민감정보 형태 문자열 (값은 가림, FR-15) */
  sensitive: SensitiveHit[];
  elapsedMs: number;
};

export type ManifestGroup = { name: string; title: string; file: string | null; pages: string[]; pdfPages: number };

export type GenerateOutput = { manifestFile: string; reportFile: string; exitCode: ExitCodeValue; message: string; pages: ManifestPage[]; combinedFile: string | null };

/** 이전 실행이 남긴 페이지별 PDF(NNN-*.pdf)만 지운다 */
function clearOldPagePdfs(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (/^\d{3}-.*\.pdf$/i.test(f)) fs.rmSync(path.join(dir, f));
}

export async function runGenerate(config: Config, configHash: string, outputDir: string, opts: GenerateOptions = {}): Promise<GenerateOutput> {
  const log = opts.log ?? silentLogger;
  const clock = opts.clock ?? realClock;
  const runId = newRunId();
  const createdAt = new Date().toISOString();
  const discovered = opts.discoveredPath ? readDiscovered(opts.discoveredPath, configHash, config.mode) : null;
  assertSafeOutputDir(config, outputDir);
  const session = await openSession(config, opts);
  try {
    const origin = session.scope.allowedOrigins[0]!;
    const query = config.crawl.query;
    let plan: Plan;
    let exitCode: ExitCodeValue = ExitCode.OK;
    const notes: string[] = [];
    const groupsOut: ManifestGroup[] = [];

    if (discovered) {
      const robots = session.robots;
      if (robots.state === 'unavailable' || (robots.state === 'present' && !robots.isAllowed(session.startUrl))) {
        return await finish(ExitCode.INPUT, 'robots.txt 확인 실패 또는 금지로 변환을 중지합니다.', null, [], null);
      }
      plan = planPages(discovered.pages, origin, session.scope, query, config.selection.order);
      if (robots.state === 'present') plan.pages = plan.pages.filter((p) => robots.isAllowed(p.url) || (plan.skipped.push({ path: p.path, reason: 'robots-disallow' }), false));
    } else {
      const outcome = await discoverInSession(session, config, log);
      writeJson(outputDir, 'discovered.json', discoveredDocument(config, configHash, session, outcome, runId, createdAt));
      if (!outcome.result || outcome.exitCode === ExitCode.INPUT || outcome.result.stopReason === 'start-failed') {
        return await finish(outcome.exitCode, outcome.message, null, [], null);
      }
      if (outcome.exitCode !== ExitCode.OK) {
        exitCode = outcome.exitCode;
        notes.push(`탐색: ${outcome.message}`);
      }
      plan = planPages(candidatesFromCrawl(outcome.result.pages), origin, session.scope, query, config.selection.order);
    }
    if (plan.orderNotFound.length) notes.push(`selection.order 중 대상에 없는 경로: ${plan.orderNotFound.join(', ')}`);
    if (plan.pages.length === 0) return await finish(ExitCode.RUN, '변환할 페이지가 없습니다(선택·성공한 페이지 0개).', plan, [], null);

    // ---- 렌더링 ----
    const pagesDir = path.join(outputDir, 'pdf', 'pages');
    fs.mkdirSync(pagesDir, { recursive: true });
    clearOldPagePdfs(pagesDir);
    const policy: LinkPolicy = { normalize: (u) => normalizeUrl(u, u, query), siteOrigin: origin, local: config.mode === 'local' };
    const includedSet = new Set(plan.pages.map((p) => p.url));
    const robotsDelay = session.robots.state === 'present' ? Math.round((session.robots.crawlDelaySec ?? 0) * 1000) : 0;
    const delay = Math.max(config.crawl.minDelayMs, robotsDelay);
    const started = clock.now();
    const manifestPages: ManifestPage[] = [];
    const parts: Array<PagePart & { index: number }> = [];
    let lastAt = -Infinity;

    for (const [i, planned] of plan.pages.entries()) {
      const order = i + 1;
      if (clock.now() - started >= config.crawl.maxTotalMs) {
        manifestPages.push(emptyPage(order, planned.url, planned.path, planned.discoveredTitle, 'max-total-time'));
        continue;
      }
      const wait = lastAt + delay - clock.now();
      if (wait > 0) await clock.sleep(wait);
      lastAt = clock.now();
      const blockedBefore = session.blocked.length;
      log.info(`렌더링 ${order}/${plan.pages.length}: ${planned.path}`);
      let r = await renderPage(session.context, planned.url, config.render, config.pdf, config.crawl.timeoutMs);
      let attempts = 1;
      while (isTransientFailure(r.failure) && attempts <= config.crawl.retries) {
        log.warn(`일시적 실패(${r.failure}) → 재시도 ${attempts}/${config.crawl.retries}: ${planned.path}`);
        await clock.sleep(Math.max(delay, 1000));
        lastAt = clock.now();
        attempts++;
        r = await renderPage(session.context, planned.url, config.render, config.pdf, config.crawl.timeoutMs);
      }
      if (attempts > 1) r.warnings.push(`retried:${attempts - 1}`);
      const blocked = session.blocked.slice(blockedBefore).map((b) => `${b.type} ${b.url}`);
      let failure = r.failure;
      if (!failure) {
        const fin = normalizeUrl(r.load.finalUrl, r.load.finalUrl, query);
        const out = fin ? scopeExclusionReason(fin, session.scope) : 'invalid-url';
        if (out) failure = `redirect-out-of-scope:${out}`;
      }
      const { title, source } = chapterTitle(r.h1, r.load.title, planned.path);
      const mp: ManifestPage = {
        order, url: planned.url, path: planned.path, title, titleSource: source,
        status: failure ? 'failed' : 'rendered', failure, pdfFile: null, pdfPages: 0, combinedStartPage: null,
        warnings: [...r.warnings, ...(blocked.length ? [`blocked-requests:${blocked.length}`] : [])],
        qa: r.qa ?? null, blocked, sensitive: r.sensitive, elapsedMs: r.load.elapsedMs,
      };
      if (failure || !r.pdf) {
        log.warn(`실패 ${planned.path}: ${failure}`);
        manifestPages.push(mp);
        continue;
      }
      mp.pdfPages = r.pdfPages ?? 0;
      if (config.pdf.pagewise) {
        const fin = await finalizePagePdf(r.pdf, includedSet, policy);
        const name = pageFileName(order, title);
        fs.writeFileSync(safeJoin(outputDir, `pdf/pages/${name}`), fin.bytes);
        mp.pdfFile = `pdf/pages/${name}`;
      }
      parts.push({ url: planned.url, chapterTitle: title, bytes: r.pdf, index: manifestPages.length });
      manifestPages.push(mp);
    }

    // 중복 장 제목 경고 (06-technical-design §3)
    const titleCount = new Map<string, number>();
    for (const p of manifestPages) titleCount.set(p.title, (titleCount.get(p.title) ?? 0) + 1);
    for (const p of manifestPages) if ((titleCount.get(p.title) ?? 0) > 1) p.warnings.push('duplicate-title');

    // ---- 통합 PDF ----
    let combined: Awaited<ReturnType<typeof buildCombined>> | null = null;
    let combinedFile: string | null = null;
    const docTitle = config.pdf.title ?? manifestPages.find((p) => p.status === 'rendered')?.title ?? 'site2pdf';
    const meta = (title: string) => ({
      title,
      subject: config.mode === 'remote' ? config.startUrl : `local: ${path.basename(config.sourcePath)}`,
      creator: `${TOOL.name} ${TOOL.version}`,
      lang: 'ko',
    });
    if (config.pdf.combined && parts.length) {
      combined = await buildCombined(parts, policy, meta(docTitle));
      combinedFile = `pdf/${slugify(config.pdf.fileName)}.pdf`;
      fs.writeFileSync(safeJoin(outputDir, combinedFile), combined.bytes);
      parts.forEach((p, k) => (manifestPages[p.index]!.combinedStartPage = combined!.partStartPages[k]!));
    }

    // ---- 그룹별 PDF (FR-11, SC-05) ----
    const groupsDir = path.join(outputDir, 'pdf', 'groups');
    if (fs.existsSync(groupsDir)) for (const f of fs.readdirSync(groupsDir)) if (/^\d{2}-.*\.pdf$/i.test(f)) fs.rmSync(path.join(groupsDir, f));
    for (const [gi, g] of config.pdf.groups.entries()) {
      const title = g.title ?? `${docTitle} - ${g.name}`;
      const gParts = parts.filter((p) => g.pathPrefixes.some((pre) => matchesPathPrefix(new URL(p.url).pathname, pre)));
      if (!gParts.length) {
        groupsOut.push({ name: g.name, title, file: null, pages: [], pdfPages: 0 });
        notes.push(`그룹 '${g.name}'에 해당하는 페이지가 없어 만들지 않았습니다.`);
        continue;
      }
      // 다른 그룹의 변환 대상 페이지 링크는 원격이면 웹 주소로 유지, 로컬이면 제거
      const res = await buildCombined(gParts, { ...policy, knownPages: includedSet }, meta(title));
      const file = `pdf/groups/${String(gi + 1).padStart(2, '0')}-${slugify(g.name)}.pdf`;
      fs.mkdirSync(groupsDir, { recursive: true });
      fs.writeFileSync(safeJoin(outputDir, file), res.bytes);
      groupsOut.push({ name: g.name, title, file, pages: gParts.map((p) => manifestPages[p.index]!.path), pdfPages: res.pages });
    }

    // 민감정보 형태 문자열 경고 요약 (FR-15)
    const sensitivePages = manifestPages.filter((p) => p.sensitive.length).length;
    if (sensitivePages) notes.push(`민감정보로 보이는 문자열이 ${sensitivePages}개 페이지에 있습니다. 외부 배포 전 검수하세요(report.md).`);

    const failed = manifestPages.filter((p) => p.status === 'failed');
    let message: string;
    if (failed.length) {
      exitCode = ExitCode.RUN;
      message = `${manifestPages.length}개 중 ${failed.length}개 페이지 변환 실패. 통합 PDF에는 성공한 ${parts.length}개만 들어 있습니다(전체 성공 아님).`;
    } else {
      message = `${parts.length}개 페이지를 PDF로 변환했습니다.${exitCode !== ExitCode.OK ? ' 단, 탐색 단계에 실패가 있었습니다.' : ''}`;
    }
    return await finish(exitCode, [message, ...notes].join(' '), plan, manifestPages, combined && combinedFile ? { file: combinedFile, ...combined } : null);

    async function finish(code: ExitCodeValue, msg: string, p: Plan | null, pages: ManifestPage[], comb: ({ file: string } & Awaited<ReturnType<typeof buildCombined>>) | null): Promise<GenerateOutput> {
      const manifest = {
        schemaVersion: 1,
        command: 'generate',
        tool: TOOL,
        runId,
        createdAt,
        finishedAt: new Date().toISOString(),
        exitCode: code,
        message: msg,
        mode: config.mode,
        input: sessionInput(config, session),
        configHash,
        discoveredFrom: opts.discoveredPath ? path.resolve(opts.discoveredPath) : 'inline-discover',
        config,
        robots: robotsSummary(session.robots),
        summary: {
          planned: p?.pages.length ?? 0,
          rendered: pages.filter((x) => x.status === 'rendered').length,
          failed: pages.filter((x) => x.status === 'failed').length,
          skipped: p?.skipped.length ?? 0,
          warnings: pages.reduce((n, x) => n + x.warnings.length, 0),
        },
        combined: comb && { file: comb.file, pages: comb.pages, outlineEntries: comb.outlineEntries, links: comb.links },
        groups: groupsOut,
        pages,
        skipped: p?.skipped ?? [],
        blockedRequests: summarizeBlocked(session.blocked),
        egressDenied: summarizeEgressDenied(session.egress.decisions),
        visualReview: '자동 검사는 겹침·가독성을 보장하지 않습니다. report.md의 체크리스트로 대표 PDF를 육안 검수하세요.',
      };
      const manifestFile = writeJson(outputDir, 'manifest.json', manifest);
      const reportFile = writeReportMd(outputDir, manifest);
      return { manifestFile, reportFile, exitCode: code, message: msg, pages, combinedFile: comb ? path.join(outputDir, comb.file) : null };
    }
  } finally {
    await session.close();
  }
}

function chapterTitle(h1: string | null, docTitle: string, p: string): { title: string; source: 'h1' | 'title' | 'path' } {
  if (h1?.trim()) return { title: h1.trim(), source: 'h1' };
  if (docTitle.trim()) return { title: docTitle.trim(), source: 'title' };
  return { title: p, source: 'path' };
}

function emptyPage(order: number, url: string, p: string, title: string, failure: string): ManifestPage {
  return { order, url, path: p, title: title || p, titleSource: 'title', status: 'failed', failure, pdfFile: null, pdfPages: 0, combinedStartPage: null, warnings: [], qa: null, blocked: [], sensitive: [], elapsedMs: 0 };
}
