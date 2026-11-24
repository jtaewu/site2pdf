// 인쇄 준비 (ADR-003, D-15): 범용 인쇄 CSS, 본문 영역·숨김 요소, 스크롤 영역 펼치기, 표 줄바꿈 단계 조정,
// 미지원 콘텐츠·가로 넘침 탐지, 앵커 프로브(정확한 앵커 링크용).
import type { Page } from 'playwright';
import type { PdfConfig, RenderConfig } from '../config/schema.ts';

const PAGE_WIDTH_MM: Record<PdfConfig['pageSize'], number> = { A4: 210, A3: 297, Letter: 215.9, Legal: 215.9 };

/** 인쇄 가능 폭(CSS px, 96dpi) */
export function printableWidthPx(pdf: PdfConfig): number {
  return Math.floor(((PAGE_WIDTH_MM[pdf.pageSize] - 2 * pdf.marginMm) / 25.4) * 96);
}

/**
 * 사이트와 무관한 기본 인쇄 CSS.
 * 표 셀은 단어 단위 줄바꿈(break-word)을 먼저 쓰고, 그래도 넘치는 표에만 글자 단위(s2p-tight)를 적용한다(D-15).
 */
export const PRINT_CSS = `
html, body { width: auto !important; min-width: 0 !important; }
pre, code, kbd, samp { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
pre { overflow: visible !important; max-height: none !important; }
img, svg, video, canvas { max-width: 100% !important; height: auto !important; }
table { max-width: 100% !important; }
td, th { white-space: normal !important; overflow-wrap: break-word !important; word-break: keep-all; }
td.s2p-break, th.s2p-break, table.s2p-tight td, table.s2p-tight th { overflow-wrap: anywhere !important; }
thead { display: table-header-group; }
h1, h2, h3, h4, h5, h6 { break-after: avoid-page; }
tr, img, figure { break-inside: avoid-page; }
`;

/** 앵커 프로브 링크 표식. 출력 후 PDF에서 이 크기 이하의 이름 링크를 제거한다 */
export const PROBE_MAX_PT = 2;
const MAX_PROBES = 3000;

export type PrepareResult = {
  /** 본문 첫 h1 텍스트 (장 제목 후보) */
  h1: string | null;
  /** 인쇄 불가·부분 지원 요소 수 (iframe, video 등) */
  unsupported: Record<string, number>;
  /** 단계 조정 후에도 인쇄 폭을 넘는 요소 */
  overflow: Array<{ tag: string; right: number }>;
  /** 글자 단위 줄바꿈으로 전환한 표 수 */
  tightTables: number;
  /** 텍스트 커버리지 계산용 단어 목록 */
  words: string[];
  probes: number;
  /** 내용 높이만큼 펼친 같은 사이트 iframe 수 */
  iframeExpanded: number;
};

export async function preparePrint(page: Page, render: RenderConfig, pdf: PdfConfig): Promise<PrepareResult> {
  await page.emulateMedia({ media: 'print' });
  await page.addStyleTag({ content: PRINT_CSS });
  // 인쇄 폭으로 레이아웃을 맞춘 뒤 측정한다
  await page.setViewportSize({ width: printableWidthPx(pdf), height: 1200 });
  return page.evaluate(
    ({ contentSelector, hideSelectors, maxProbes, printCss }) => {
      const root = (contentSelector && document.querySelector(contentSelector)) || document.body;
      // 1) 본문 영역만 남기기 (설정값으로만)
      if (contentSelector && root !== document.body) {
        document.body.replaceChildren(root);
        (root as HTMLElement).style.setProperty('margin', '0', 'important');
        (root as HTMLElement).style.setProperty('max-width', 'none', 'important');
      }
      // 2) 고정·스티키 요소(헤더·사이드바)와 설정된 요소 숨김
      const hide = (el: Element) => (el as HTMLElement).style.setProperty('display', 'none', 'important');
      for (const sel of hideSelectors) document.querySelectorAll(sel).forEach(hide);
      let hiddenFixed = 0;
      // 숨긴 상단 고정 헤더의 아래 끝 (본문이 그만큼 띄워 둔 위쪽 여백을 없애기 위해)
      let topHeaderBottom = 0;
      const vw = document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'sticky') {
          const r = el.getBoundingClientRect();
          if (r.top <= 4 && r.width >= vw * 0.5 && r.height > 0 && r.height < 300) topHeaderBottom = Math.max(topHeaderBottom, r.bottom);
          hide(el);
          hiddenFixed++;
        }
        // 3) 내부 스크롤 영역은 펼쳐서 잘림 방지
        else if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 2 && el.tagName !== 'BODY') {
          const s = (el as HTMLElement).style;
          s.setProperty('overflow', 'visible', 'important');
          s.setProperty('max-height', 'none', 'important');
          s.setProperty('height', 'auto', 'important');
        }
      }
      // 지연 로딩 이미지를 즉시 로딩으로
      document.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager'));

      const W = document.documentElement.clientWidth;
      // 고정 사이드바를 숨기면 본문이 그 자리만큼 띄워 둔 큰 가로 여백이 남는다 → 인쇄 폭의 15% 이상 여백은 0으로
      let resetOffsets = 0;
      if (hiddenFixed > 0) {
        for (const el of document.querySelectorAll('body, body *')) {
          const cs = getComputedStyle(el);
          const s = (el as HTMLElement).style;
          for (const prop of ['margin-left', 'margin-right', 'padding-left', 'padding-right']) {
            if (parseFloat(cs.getPropertyValue(prop)) >= W * 0.15) {
              s.setProperty(prop, '0', 'important');
              resetOffsets++;
            }
          }
        }
      }
      // 숨긴 상단 헤더 높이만큼 띄워 둔 위쪽 여백(본문 바깥 2단계까지)도 제거
      if (topHeaderBottom > 0) {
        for (const el of document.querySelectorAll('body, body > *, body > * > *')) {
          const cs = getComputedStyle(el);
          for (const prop of ['margin-top', 'padding-top']) {
            const v = parseFloat(cs.getPropertyValue(prop));
            if (v >= topHeaderBottom * 0.6 && v <= topHeaderBottom + 40) {
              (el as HTMLElement).style.setProperty(prop, '0', 'important');
              resetOffsets++;
            }
          }
        }
      }
      // 같은 사이트 iframe은 내용 높이만큼 펼쳐 전체가 인쇄되게 한다 (다른 출처·차단된 iframe은 미지원 경고)
      let iframeExpanded = 0;
      let iframeOpaque = 0;
      for (const f of document.body.querySelectorAll('iframe')) {
        let inner: Document | null = null;
        try {
          inner = (f as HTMLIFrameElement).contentDocument;
        } catch {}
        if (inner?.body && inner.documentElement.scrollHeight > 0) {
          // iframe 문서에도 같은 인쇄 규칙 적용: 인쇄 CSS, 고정 요소 숨김
          const st = inner.createElement('style');
          st.textContent = printCss;
          inner.head?.appendChild(st);
          let innerHidden = 0;
          for (const el of inner.querySelectorAll('body *')) {
            const p = inner.defaultView?.getComputedStyle(el).position;
            if (p === 'fixed' || p === 'sticky') {
              (el as HTMLElement).style.setProperty('display', 'none', 'important');
              innerHidden++;
            }
          }
          if (innerHidden && inner.defaultView) {
            const iw = inner.documentElement.clientWidth;
            for (const el of inner.querySelectorAll('body, body *')) {
              const cs = inner.defaultView.getComputedStyle(el);
              for (const prop of ['margin-left', 'margin-right', 'padding-left', 'padding-right', 'margin-top', 'padding-top']) {
                const v = parseFloat(cs.getPropertyValue(prop));
                if ((prop.endsWith('top') ? v >= 40 && v <= 200 : v >= iw * 0.15)) (el as HTMLElement).style.setProperty(prop, '0', 'important');
              }
            }
          }
          const s = (f as HTMLElement).style;
          s.setProperty('height', `${inner.documentElement.scrollHeight + 4}px`, 'important');
          s.setProperty('width', '100%', 'important');
          iframeExpanded++;
        } else iframeOpaque++;
      }
      // 4) 넘치는 표: 먼저 긴 끊김 없는 토큰(URL·상수명 등)이 있는 셀만 글자 단위 줄바꿈, 그래도 넘치면 표 전체
      let tightTables = 0;
      for (const t of document.querySelectorAll('table')) {
        if (t.getBoundingClientRect().right <= W + 1) continue;
        for (const cell of t.querySelectorAll('td, th')) {
          if ((cell.textContent ?? '').split(/\s+/).some((tok) => tok.length > 12)) cell.classList.add('s2p-break');
        }
        if (t.getBoundingClientRect().right > W + 1) {
          t.classList.add('s2p-tight');
          tightTables++;
        }
      }
      // 5) 미지원 콘텐츠
      const unsupported: Record<string, number> = {};
      if (iframeOpaque) unsupported.iframe = iframeOpaque;
      for (const tag of ['video', 'audio', 'canvas', 'embed', 'object']) {
        const n = document.body.querySelectorAll(tag).length;
        if (n) unsupported[tag] = n;
      }
      // 6) 가로 넘침 (보고된 요소의 하위는 생략)
      const overflow: Array<{ tag: string; right: number; el: Element }> = [];
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > W + 2 && !overflow.some((o) => o.el.contains(el))) overflow.push({ tag: el.tagName.toLowerCase(), right: Math.round(r.right), el });
      }
      // 7) 앵커 프로브: 모든 id에 대해 1px 자기 링크를 넣어 Chrome이 named destination을 만들게 한다
      const ids = [...document.body.querySelectorAll('[id]')].map((e) => e.id).filter(Boolean).slice(0, maxProbes);
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible';
      for (const id of ids) {
        const a = document.createElement('a');
        a.href = `#${encodeURIComponent(id)}`;
        a.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;display:block';
        box.appendChild(a);
      }
      document.body.appendChild(box);

      const h1 = document.body.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || null;
      const words = [...new Set(document.body.innerText.split(/\s+/).filter((w) => w.length >= 2))];
      return { h1, unsupported, overflow: overflow.slice(0, 10).map(({ tag, right }) => ({ tag, right })), tightTables, words, probes: ids.length, iframeExpanded };
    },
    { contentSelector: render.contentSelector ?? null, hideSelectors: render.hideSelectors, maxProbes: MAX_PROBES, printCss: PRINT_CSS },
  );
}
