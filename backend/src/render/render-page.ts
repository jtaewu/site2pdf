// 페이지 1개를 열어 판정 → 인쇄 준비 → PDF 출력 → 자동 QA (FR-06, FR-08)
import type { BrowserContext } from 'playwright';
import type { PdfConfig, RenderConfig } from '../config/schema.ts';
import { openPage, type LoadResult } from '../browser/page-loader.ts';
import { preparePrint } from './print.ts';
import { extractPdfText, textCoverage } from '../pdf/pdf-text.ts';

/** 텍스트 커버리지가 이보다 낮으면 잘림·누락 경고 */
export const COVERAGE_WARN = 0.99;

export type RenderedPage = {
  load: LoadResult;
  failure?: string;
  pdf?: Uint8Array;
  pdfPages?: number;
  h1: string | null;
  warnings: string[];
  qa?: { coverage: number; missingSamples: string[]; overflow: Array<{ tag: string; right: number }>; tightTables: number };
};

export async function renderPage(context: BrowserContext, url: string, render: RenderConfig, pdf: PdfConfig, timeoutMs: number): Promise<RenderedPage> {
  const { page, result } = await openPage(context, url, render, timeoutMs);
  const out: RenderedPage = { load: result, h1: null, warnings: [] };
  try {
    if (result.failure) {
      out.failure = result.failure;
      return out;
    }
    // 판정 이후 문서가 바뀌면(스스로 이동) 인쇄 결과를 믿을 수 없다
    let navigated = false;
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) navigated = true;
    });
    const prep = await preparePrint(page, render, pdf);
    out.h1 = prep.h1;
    const margin = `${pdf.marginMm}mm`;
    const bytes = await withTimeout(
      page.pdf({ format: pdf.pageSize, printBackground: pdf.printBackground, outline: true, tagged: true, margin: { top: margin, bottom: margin, left: margin, right: margin } }),
      timeoutMs,
      'pdf-timeout',
    );
    if (navigated) {
      out.failure = 'navigated-during-render';
      return out;
    }
    const text = await extractPdfText(bytes);
    const cov = textCoverage(prep.words, text.text);
    out.pdf = bytes;
    out.pdfPages = text.pages;
    out.qa = { coverage: cov.ratio, missingSamples: cov.missing, overflow: prep.overflow, tightTables: prep.tightTables };
    for (const [tag, n] of Object.entries(prep.unsupported)) out.warnings.push(`unsupported-content:${tag}x${n}`);
    if (prep.iframeExpanded) out.warnings.push(`iframe-expanded:${prep.iframeExpanded}`);
    if (prep.overflow.length) out.warnings.push(`horizontal-overflow:${prep.overflow.map((o) => o.tag).join(',')}`);
    if (cov.ratio < COVERAGE_WARN) out.warnings.push(`text-coverage:${cov.ratio}`);
    return out;
  } catch (e) {
    out.failure = `render-error: ${(e as Error).message.split('\n')[0]}`;
    return out;
  } finally {
    await page.close().catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(code)), ms)))]).finally(() => clearTimeout(timer));
}
