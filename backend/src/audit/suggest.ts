// audit용 렌더 설정 추천 (FR-14 보조): 특정 프레임워크를 가정하지 않고 의미 요소와 본문 밀도로 후보를 찾는다
import type { Page } from 'playwright';

export type RenderSuggestion = {
  contentSelector: string | null;
  readySelector: string | null;
  candidates: Array<{ selector: string; textRatio: number; hasH1: boolean }>;
  reason: string;
};

export function suggestRender(page: Page): Promise<RenderSuggestion> {
  return page.evaluate(() => {
    const bodyLen = Math.max(1, document.body.innerText.trim().length);
    const ratio = (el: Element) => Number(((el as HTMLElement).innerText.trim().length / bodyLen).toFixed(2));
    const h1 = document.querySelector('h1');
    const unique = (sel: string) => {
      try {
        return document.querySelectorAll(sel).length === 1;
      } catch {
        return false;
      }
    };
    const selectorOf = (el: Element): string | null => {
      if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
      const tag = el.tagName.toLowerCase();
      if (unique(tag)) return tag;
      const cls = [...el.classList].filter((c) => /^[a-zA-Z][\w-]*$/.test(c)).slice(0, 2);
      const withCls = cls.length ? `${tag}.${cls.join('.')}` : null;
      return withCls && unique(withCls) ? withCls : null;
    };
    const candidates: Array<{ selector: string; textRatio: number; hasH1: boolean; semantic: boolean; el: Element }> = [];
    const add = (el: Element | null, semantic: boolean) => {
      if (!el || el === document.body || candidates.some((c) => c.el === el)) return;
      const selector = selectorOf(el);
      if (selector) candidates.push({ selector, textRatio: ratio(el), hasH1: !!h1 && el.contains(h1), semantic, el });
    };
    // HTML 의미 요소: 본문 영역이라는 강한 신호
    for (const sel of ['main', 'article', '[role="main"]']) document.querySelectorAll(sel).forEach((el) => add(el, true));
    for (const sel of ['#content', '#main', '.content', '.main-content']) {
      try {
        document.querySelectorAll(sel).forEach((el) => add(el, false));
      } catch {}
    }
    // 첫 h1에서 위로 올라가며 본문 대부분(60% 이상)을 담는 가장 작은 영역
    for (let el = h1?.parentElement ?? null; el && el !== document.body; el = el.parentElement) {
      if (ratio(el) >= 0.6) {
        add(el, false);
        break;
      }
    }
    const size = (el: Element) => el.querySelectorAll('*').length;
    // 1순위: 첫 h1을 담은 의미 요소(가장 작은 것), 2순위: 첫 h1을 담고 본문 50% 이상인 가장 작은 영역
    const semantic = candidates.filter((c) => c.semantic && c.hasH1 && c.textRatio >= 0.1).sort((a, b) => size(a.el) - size(b.el));
    const dense = candidates.filter((c) => c.hasH1 && c.textRatio >= 0.5).sort((a, b) => size(a.el) - size(b.el));
    const best = semantic[0] ?? dense[0] ?? null;
    const reason = !best
      ? '조건(첫 h1 포함)을 만족하는 본문 후보 없음'
      : best === semantic[0]
        ? `첫 h1을 담은 HTML 의미 요소(본문 텍스트 ${Math.round(best.textRatio * 100)}%)`
        : `첫 h1을 포함하고 본문 텍스트의 ${Math.round(best.textRatio * 100)}%를 담는 가장 작은 영역`;
    return {
      contentSelector: best?.selector ?? null,
      readySelector: best ? `${best.selector} h1` : null,
      candidates: candidates.map(({ selector, textRatio, hasH1 }) => ({ selector, textRatio, hasH1 })),
      reason,
    };
  });
}
