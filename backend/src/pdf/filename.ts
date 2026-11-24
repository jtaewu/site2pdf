// 출력 파일명 정제 (06-technical-design §4, T-18 일부): 인덱스 + 정제된 제목, 경로 탈출·예약 이름 방지
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function slugify(title: string, maxLen = 60): string {
  let s = title
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/[\s.]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
  s = [...s].slice(0, maxLen).join('').replace(/[-.]+$/g, '');
  if (!s || RESERVED.test(s)) s = `page${s ? `-${s}` : ''}`;
  return s;
}

/** 페이지별 PDF 파일명: 001-제목.pdf (인덱스로 충돌 방지) */
export function pageFileName(order: number, title: string): string {
  return `${String(order).padStart(3, '0')}-${slugify(title)}.pdf`;
}
