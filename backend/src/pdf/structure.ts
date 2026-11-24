// pdf-lib 저수준 처리: named destination 해석, 앵커 프로브 제거, 링크 재작성, 북마크 읽기/쓰기
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString, type PDFObject, type PDFPage } from 'pdf-lib';
import { PROBE_MAX_PT } from '../render/print.ts';

export type DestPoint = { pageIndex: number; x: number | null; y: number | null };
export type OutlineNode = { title: string; dest: DestPoint | null; children: OutlineNode[] };

const N = (s: string) => PDFName.of(s);

function textOf(o: PDFObject | undefined): string | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return undefined;
}

function safeDecodeUri(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function numOf(o: PDFObject | undefined): number | null {
  return o instanceof PDFNumber ? o.asNumber() : null;
}

/** 명시 목적지 배열 [pageRef /XYZ x y z | /Fit ...] → 페이지 인덱스·좌표 */
function explicitDest(doc: PDFDocument, arr: PDFArray, pageIndexOf: Map<string, number>): DestPoint | null {
  const ref = arr.get(0);
  if (!(ref instanceof PDFRef)) return null;
  const pageIndex = pageIndexOf.get(ref.toString());
  if (pageIndex === undefined) return null;
  const kind = arr.get(1);
  if (kind instanceof PDFName && kind.decodeText() === 'XYZ') return { pageIndex, x: numOf(arr.get(2)), y: numOf(arr.get(3)) };
  return { pageIndex, x: null, y: null };
}

function pageIndexMap(doc: PDFDocument): Map<string, number> {
  return new Map(doc.getPages().map((p, i) => [p.ref.toString(), i]));
}

/** 카탈로그 /Dests 와 /Names/Dests 의 이름 목적지를 모두 읽는다 */
export function readNamedDests(doc: PDFDocument): Map<string, DestPoint> {
  const out = new Map<string, DestPoint>();
  const idx = pageIndexMap(doc);
  const put = (name: string, v: PDFObject | undefined) => {
    let arr = v instanceof PDFRef ? doc.context.lookup(v) : v;
    if (arr instanceof PDFDict) arr = arr.lookup(N('D'));
    if (arr instanceof PDFArray) {
      const d = explicitDest(doc, arr, idx);
      if (!d) return;
      out.set(name, d);
      // Chrome은 비ASCII id(예: 한글)를 퍼센트 인코딩한 이름으로 저장한다 → 디코딩한 이름으로도 찾을 수 있게
      const decoded = safeDecodeUri(name);
      if (decoded !== name && !out.has(decoded)) out.set(decoded, d);
    }
  };
  const dests = doc.catalog.lookupMaybe(N('Dests'), PDFDict);
  if (dests) for (const [k, v] of dests.entries()) put(k.decodeText(), v);
  const walk = (node: PDFDict | undefined) => {
    if (!node) return;
    const names = node.lookupMaybe(N('Names'), PDFArray);
    if (names) for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = textOf(names.lookup(i));
      if (key !== undefined) put(key, names.get(i + 1));
    }
    const kids = node.lookupMaybe(N('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  };
  walk(doc.catalog.lookupMaybe(N('Names'), PDFDict)?.lookupMaybe(N('Dests'), PDFDict));
  return out;
}

/** 북마크 트리 읽기 */
export function readOutline(doc: PDFDocument): OutlineNode[] {
  const idx = pageIndexMap(doc);
  const named = readNamedDests(doc);
  const destOf = (item: PDFDict): DestPoint | null => {
    let d: PDFObject | undefined = item.lookup(N('Dest'));
    if (!d) {
      const a = item.lookupMaybe(N('A'), PDFDict);
      if (a && textOf(a.get(N('S'))) === 'GoTo') d = a.lookup(N('D'));
    }
    if (d instanceof PDFArray) return explicitDest(doc, d, idx);
    const name = textOf(d);
    return name !== undefined ? (named.get(name) ?? null) : null;
  };
  const walk = (first: PDFDict | undefined, depth: number): OutlineNode[] => {
    const list: OutlineNode[] = [];
    let cur = first;
    let guard = 0;
    while (cur && guard++ < 10_000 && depth < 32) {
      list.push({ title: textOf(cur.lookup(N('Title'))) ?? '', dest: destOf(cur), children: walk(cur.lookupMaybe(N('First'), PDFDict), depth + 1) });
      cur = cur.lookupMaybe(N('Next'), PDFDict);
    }
    return list;
  };
  return walk(doc.catalog.lookupMaybe(N('Outlines'), PDFDict)?.lookupMaybe(N('First'), PDFDict), 0);
}

function annotsOf(page: PDFPage): PDFArray | undefined {
  return page.node.lookupMaybe(N('Annots'), PDFArray);
}

function rectSize(a: PDFDict): { w: number; h: number } {
  const r = a.lookupMaybe(N('Rect'), PDFArray);
  if (!r || r.size() < 4) return { w: Infinity, h: Infinity };
  const n = [0, 1, 2, 3].map((i) => numOf(r.lookup(i)) ?? 0);
  return { w: Math.abs(n[2]! - n[0]!), h: Math.abs(n[3]! - n[1]!) };
}

/** 앵커 프로브가 만든 작은 이름 링크 제거 */
export function removeProbeLinks(doc: PDFDocument): number {
  let removed = 0;
  for (const page of doc.getPages()) {
    const annots = annotsOf(page);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i, PDFDict);
      const { w, h } = rectSize(a);
      if (textOf(a.get(N('Subtype'))) === 'Link' && a.has(N('Dest')) && w <= PROBE_MAX_PT && h <= PROBE_MAX_PT) {
        annots.remove(i);
        removed++;
      }
    }
  }
  return removed;
}

export type LinkTarget =
  | { kind: 'uri'; uri: string }
  | { kind: 'named'; name: string };
export type LinkAction = { action: 'keep' } | { action: 'remove' } | { action: 'goto'; page: PDFPage; y: number | null; x: number | null };
export type LinkStats = { kept: number; removed: number; gotos: number };

/** 모든 링크 주석을 decide 결과에 따라 유지·제거·문서 내부 이동으로 바꾼다 */
export function rewriteLinks(doc: PDFDocument, pages: PDFPage[], decide: (target: LinkTarget, pageIndex: number) => LinkAction): LinkStats {
  const stats: LinkStats = { kept: 0, removed: 0, gotos: 0 };
  pages.forEach((page, pageIndex) => {
    const annots = annotsOf(page);
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i, PDFDict);
      if (textOf(a.get(N('Subtype'))) !== 'Link') continue;
      let target: LinkTarget | null = null;
      const act = a.lookupMaybe(N('A'), PDFDict);
      const uri = act && textOf(act.get(N('S'))) === 'URI' ? textOf(act.lookup(N('URI'))) : undefined;
      if (uri !== undefined) target = { kind: 'uri', uri };
      else {
        const name = textOf(a.lookup(N('Dest')));
        if (name !== undefined) target = { kind: 'named', name };
      }
      if (!target) {
        stats.kept++;
        continue;
      }
      const r = decide(target, pageIndex);
      if (r.action === 'keep') stats.kept++;
      else if (r.action === 'remove') {
        annots.remove(i);
        stats.removed++;
      } else {
        a.delete(N('A'));
        a.set(N('Dest'), destArray(doc, r.page, r.x, r.y));
        stats.gotos++;
      }
    }
  });
  return stats;
}

function destArray(doc: PDFDocument, page: PDFPage, x: number | null, y: number | null): PDFArray {
  // y가 없으면 페이지 맨 위로
  return doc.context.obj([page.ref, 'XYZ', x ?? 0, y ?? page.getHeight(), PDFNull]) as PDFArray;
}

export type OutlineEntry = { title: string; page: PDFPage; x: number | null; y: number | null; children: OutlineEntry[] };

/** 계층 북마크 작성 (기존 북마크 대체) */
export function writeOutline(doc: PDFDocument, tree: OutlineEntry[]): void {
  if (!tree.length) {
    doc.catalog.delete(N('Outlines'));
    return;
  }
  const ctx = doc.context;
  const build = (list: OutlineEntry[], parent: PDFRef): [PDFRef, PDFRef, number] => {
    const refs = list.map(() => ctx.nextRef());
    let total = 0;
    list.forEach((it, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(it.title), Parent: parent, Dest: destArray(doc, it.page, it.x, it.y) }) as PDFDict;
      if (i > 0) dict.set(N('Prev'), refs[i - 1]!);
      if (i < list.length - 1) dict.set(N('Next'), refs[i + 1]!);
      if (it.children.length) {
        const [first, last, count] = build(it.children, refs[i]!);
        dict.set(N('First'), first);
        dict.set(N('Last'), last);
        // 음수: 하위 항목을 닫힌 상태로 표시 (장 목록이 먼저 보이도록)
        dict.set(N('Count'), ctx.obj(-count));
      }
      ctx.assign(refs[i]!, dict);
      total++;
    });
    return [refs[0]!, refs[refs.length - 1]!, total];
  };
  const root = ctx.nextRef();
  const [first, last, count] = build(tree, root);
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: count }));
  doc.catalog.set(N('Outlines'), root);
  doc.catalog.set(N('PageMode'), N('UseOutlines'));
}
