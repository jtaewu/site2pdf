// pdfjs로 PDF 텍스트를 추출한다 (텍스트 커버리지 QA, 테스트 검증용)
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfTextInfo = { pages: number; text: string };

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextInfo> {
  // pdfjs는 입력 버퍼를 넘겨받아 비우므로 복사본을 준다
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false, useSystemFonts: false }).promise;
  try {
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      text += `${tc.items.map((t) => ('str' in t ? t.str : '')).join('')}\n`;
    }
    return { pages: doc.numPages, text };
  } finally {
    await doc.destroy();
  }
}

/** DOM 단어 중 PDF 텍스트에 존재하는 비율 (공백 무시) */
export function textCoverage(words: string[], pdfText: string): { ratio: number; missing: string[] } {
  // 보이지 않는 문자(제로폭 공백·결합자·BOM·이모지 변형 선택자)는 PDF 텍스트에서 빠지므로 비교에서 제외한다
  // (예: Docusaurus 제목 끝의 U+200B 때문에 생기던 오탐)
  const invisible = /[​-‍⁠﻿︎️]/g;
  const flat = pdfText.replace(invisible, '').replace(/\s+/g, '');
  const missing = words.map((w) => w.replace(invisible, '')).filter((w) => w && !flat.includes(w));
  return { ratio: words.length ? Number((1 - missing.length / words.length).toFixed(4)) : 1, missing: missing.slice(0, 10) };
}
