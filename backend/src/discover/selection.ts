// FR-05 페이지 포함·제외 선택. 패턴은 URL 경로(pathname)에 대한 glob (picomatch).
import picomatch from 'picomatch';
import type { SelectionConfig } from '../config/schema.ts';

export type SelectionResult = { selected: true } | { selected: false; reason: string };

export function createSelector(sel: SelectionConfig): (url: string) => SelectionResult {
  const opts = { dot: true };
  const includes = sel.include.map((p) => [p, picomatch(p, opts)] as const);
  const excludes = sel.exclude.map((p) => [p, picomatch(p, opts)] as const);
  return (url) => {
    const path = decodeURI(new URL(url).pathname);
    const ex = excludes.find(([, m]) => m(path));
    if (ex) return { selected: false, reason: `selection-exclude:${ex[0]}` };
    if (includes.length && !includes.some(([, m]) => m(path))) return { selected: false, reason: 'selection-not-included' };
    return { selected: true };
  };
}
