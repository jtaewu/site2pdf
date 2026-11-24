// 변환 대상 페이지 목록 확정: discovered.json(검수된 목록) 또는 새 탐색 결과에서 선택된 성공 페이지만, 지정 순서 적용
import fs from 'node:fs';
import { ExitCode, Site2pdfError } from '../errors.ts';
import { normalizeUrl, scopeExclusionReason, type QueryPolicy, type Scope } from '../fetch-policy/url.ts';
import type { PageRecord } from '../discover/crawler.ts';
import { toPath } from '../discover/command.ts';

export type PlannedPage = { url: string; path: string; discoveredOrder: number; discoveredTitle: string };
export type Plan = { pages: PlannedPage[]; skipped: Array<{ path: string; reason: string }>; orderNotFound: string[] };

type DiscoveredFile = {
  schemaVersion: number;
  command: string;
  mode: string;
  configHash: string;
  pages: Array<Pick<PageRecord, 'order' | 'status' | 'selected' | 'title' | 'failure' | 'selectionReason'> & { path: string }>;
};

const fail = (code: string, msg: string) => new Site2pdfError(ExitCode.INPUT, code, msg);

/** 검수된 discovered.json 읽기. 같은 설정(configHash)으로 만든 목록만 받는다 */
export function readDiscovered(file: string, configHash: string, mode: string): DiscoveredFile {
  let d: DiscoveredFile;
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8')) as DiscoveredFile;
  } catch (e) {
    throw fail('discovered-unreadable', `discovered.json을 읽을 수 없습니다: ${file} (${(e as Error).message})`);
  }
  if (d.schemaVersion !== 1 || d.command !== 'discover' || !Array.isArray(d.pages)) throw fail('discovered-invalid', `discover 결과 파일이 아닙니다: ${file}`);
  if (d.mode !== mode) throw fail('discovered-mode-mismatch', `discovered.json 모드(${d.mode})가 현재 입력 모드(${mode})와 다릅니다.`);
  if (d.configHash !== configHash) {
    throw fail('discovered-config-mismatch', '설정이 discover 실행 때와 다릅니다. 같은 설정으로 discover를 다시 실행해 목록을 검수한 뒤 generate 하세요.');
  }
  return d;
}

type Candidate = { path: string; order: number; status: string; selected: boolean; title: string; failure?: string; selectionReason?: string };

export function planPages(candidates: Candidate[], origin: string, scope: Scope, query: QueryPolicy, orderPaths: string[]): Plan {
  const skipped: Plan['skipped'] = [];
  const pages: PlannedPage[] = [];
  const seen = new Set<string>();
  for (const c of [...candidates].sort((a, b) => a.order - b.order)) {
    if (c.status !== 'ok') {
      skipped.push({ path: c.path, reason: `discover-failed:${c.failure ?? 'unknown'}` });
      continue;
    }
    if (!c.selected) {
      skipped.push({ path: c.path, reason: c.selectionReason ?? 'not-selected' });
      continue;
    }
    const url = normalizeUrl(c.path, origin, query);
    // 목록 파일을 다시 검증한다 (수정된 목록이 범위를 넓히지 못하게)
    const out = url ? scopeExclusionReason(url, scope) : 'invalid-url';
    if (!url || out) {
      skipped.push({ path: c.path, reason: `out-of-scope:${out}` });
      continue;
    }
    if (seen.has(url)) {
      skipped.push({ path: c.path, reason: 'duplicate' });
      continue;
    }
    seen.add(url);
    pages.push({ url, path: toPath(url), discoveredOrder: c.order, discoveredTitle: c.title });
  }
  // 지정 순서(selection.order)의 경로를 앞에, 나머지는 발견 순서 (SC-04)
  const orderNotFound: string[] = [];
  const front: PlannedPage[] = [];
  for (const p of orderPaths) {
    const i = pages.findIndex((x) => x.path === p);
    if (i < 0) orderNotFound.push(p);
    else front.push(pages.splice(i, 1)[0]!);
  }
  return { pages: [...front, ...pages], skipped, orderNotFound };
}

export function candidatesFromCrawl(pages: PageRecord[]): Candidate[] {
  return pages.map((p) => ({ path: toPath(p.url), order: p.order, status: p.status, selected: p.selected, title: p.title, failure: p.failure, selectionReason: p.selectionReason }));
}
