// 페이지별 PDF 후처리와 통합 PDF 조립 (ADR-003 A방식, FR-06/07/10, D-10)
import { PDFDocument, PDFName, PDFString, type PDFPage } from 'pdf-lib';
import { readNamedDests, readOutline, removeProbeLinks, rewriteLinks, writeOutline, type DestPoint, type LinkAction, type LinkStats, type LinkTarget, type OutlineEntry, type OutlineNode } from './structure.ts';

export type LinkPolicy = {
  /** 링크 URL을 탐색 규칙대로 정규화 (fragment 제외). 해석 불가면 null */
  normalize(uri: string): string | null;
  /** 사이트 origin (이 origin의 링크 중 포함되지 않은 페이지는 링크를 제거) */
  siteOrigin: string;
  /** 로컬 모드면 페이지별 PDF 안의 사이트 링크(루프백 주소)를 남기지 않는다 */
  local: boolean;
};

export type PagePart = { url: string; chapterTitle: string; bytes: Uint8Array };

type LinkClass = { type: 'included'; url: string; fragment: string | null } | { type: 'site-excluded' } | { type: 'external' };

function classify(uri: string, included: Set<string>, policy: LinkPolicy): LinkClass {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { type: 'external' };
  }
  if (u.origin !== policy.siteOrigin) return { type: 'external' };
  const n = policy.normalize(uri);
  const fragment = u.hash ? safeDecode(u.hash.slice(1)) : null;
  if (n && included.has(n)) return { type: 'included', url: n, fragment };
  return { type: 'site-excluded' };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 페이지별 PDF 후처리: 앵커 프로브 제거, 링크 정책(D-10) 적용.
 * 같은 문서 안 앵커는 유지, 제외 페이지 링크는 제거(텍스트만), 외부 링크 유지,
 * 포함 페이지 링크는 원격이면 웹 주소로 유지·로컬이면 제거.
 */
export async function finalizePagePdf(bytes: Uint8Array, included: Set<string>, policy: LinkPolicy): Promise<{ bytes: Uint8Array; links: LinkStats }> {
  const doc = await PDFDocument.load(bytes);
  removeProbeLinks(doc);
  const links = rewriteLinks(doc, doc.getPages(), (t): LinkAction => {
    if (t.kind === 'named') return { action: 'keep' };
    const c = classify(t.uri, included, policy);
    if (c.type === 'external') return { action: 'keep' };
    if (c.type === 'included' && !policy.local) return { action: 'keep' };
    return { action: 'remove' };
  });
  return { bytes: await doc.save(), links };
}

export type CombinedMeta = { title: string; subject: string; creator: string; lang?: string };
export type CombinedResult = {
  bytes: Uint8Array;
  pages: number;
  /** 각 파트가 시작하는 통합 PDF 페이지 번호(1부터) */
  partStartPages: number[];
  outlineEntries: number;
  links: LinkStats & { anchorExact: number; brokenNamed: number };
};

/** 파트 순서대로 병합하고 2단계 이상 북마크·내부 링크를 재구성한다 */
export async function buildCombined(parts: PagePart[], policy: LinkPolicy, meta: CombinedMeta): Promise<CombinedResult> {
  const out = await PDFDocument.create();
  out.setTitle(meta.title, { showInWindowTitleBar: true });
  out.setSubject(meta.subject);
  out.setCreator(meta.creator);
  out.setProducer(meta.creator);
  out.setCreationDate(new Date());
  if (meta.lang) out.catalog.set(PDFName.of('Lang'), PDFString.of(meta.lang));

  type Src = { start: number; count: number; dests: Map<string, DestPoint>; outline: OutlineNode[] };
  const srcs: Src[] = [];
  const included = new Map<string, number>();
  for (const [i, part] of parts.entries()) {
    const doc = await PDFDocument.load(part.bytes);
    removeProbeLinks(doc);
    const src: Src = { start: out.getPageCount(), count: doc.getPageCount(), dests: readNamedDests(doc), outline: readOutline(doc) };
    for (const p of await out.copyPages(doc, doc.getPageIndices())) out.addPage(p);
    srcs.push(src);
    const n = policy.normalize(part.url);
    if (n && !included.has(n)) included.set(n, i);
  }
  const pages = out.getPages();
  const partOfPage = (pageIndex: number) => srcs.findIndex((s) => pageIndex >= s.start && pageIndex < s.start + s.count);
  const goto = (s: Src, d: DestPoint | null): LinkAction => ({ action: 'goto', page: pages[s.start + (d?.pageIndex ?? 0)]!, x: d ? d.x : null, y: d ? d.y : null });

  let anchorExact = 0;
  let brokenNamed = 0;
  const stats = rewriteLinks(out, pages, (t: LinkTarget, pageIndex): LinkAction => {
    if (t.kind === 'named') {
      const s = srcs[partOfPage(pageIndex)]!;
      const d = s.dests.get(t.name);
      if (!d) {
        brokenNamed++;
        return { action: 'remove' };
      }
      return goto(s, d);
    }
    const c = classify(t.uri, new Set(included.keys()), policy);
    if (c.type === 'external') return { action: 'keep' };
    if (c.type === 'site-excluded') return { action: 'remove' };
    const s = srcs[included.get(c.url)!]!;
    const d = c.fragment ? s.dests.get(c.fragment) : undefined;
    if (d) anchorExact++;
    return goto(s, d ?? null);
  });

  // 북마크: 장 = 파트 제목, 하위 = 파트 PDF의 제목 북마크 (첫 h1이 장 제목과 같으면 그 하위를 끌어올림)
  let entries = 0;
  const convert = (s: Src, nodes: OutlineNode[]): OutlineEntry[] =>
    nodes.map((n) => {
      entries++;
      return { title: n.title, page: pages[s.start + (n.dest?.pageIndex ?? 0)]!, x: n.dest?.x ?? null, y: n.dest?.y ?? null, children: convert(s, n.children) };
    });
  const tree: OutlineEntry[] = parts.map((part, i) => {
    const s = srcs[i]!;
    const [first, ...rest] = s.outline;
    const kids = first && first.title.trim() === part.chapterTitle.trim() ? [...first.children, ...rest] : s.outline;
    entries++;
    return { title: part.chapterTitle, page: pages[s.start]!, x: null, y: null, children: convert(s, kids) };
  });
  writeOutline(out, tree);

  return {
    bytes: await out.save(),
    pages: out.getPageCount(),
    partStartPages: srcs.map((s) => s.start + 1),
    outlineEntries: entries,
    links: { ...stats, anchorExact, brokenNamed },
  };
}

export type { PDFPage };
