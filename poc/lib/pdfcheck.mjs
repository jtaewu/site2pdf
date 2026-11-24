// pdfjs로 생성 PDF를 검사: 페이지 수, 텍스트 추출, 북마크(outline), 링크 주석 종류
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function inspectPdf(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await getDocument({ data, verbosity: 0, isEvalSupported: false }).promise;
  let text = '';
  const links = { uri: 0, internal: 0, uriSamples: [] };
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    text += tc.items.map(t => t.str).join('') + '\n';
    for (const a of await p.getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      if (a.url) { links.uri++; if (links.uriSamples.length < 3) links.uriSamples.push(a.url); }
      else if (a.dest) links.internal++;
    }
  }
  const outline = await doc.getOutline();
  const flat = [];
  const walk = (items, d) => (items || []).forEach(it => { flat.push('  '.repeat(d) + it.title); walk(it.items, d + 1); });
  walk(outline, 0);
  const res = { pages: doc.numPages, textLength: text.length, text, outline: flat, links };
  await doc.destroy();
  return res;
}
