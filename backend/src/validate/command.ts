// validate 명령 (Phase 3): generate 결과물이 manifest와 일치하고 손상·누락·경로 이탈이 없는지 검증한다.
// 브라우저·네트워크를 쓰지 않는다. 결과는 manifest 옆 validation.json.
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { ExitCode, Site2pdfError, type ExitCodeValue } from '../errors.ts';
import { readOutline } from '../pdf/structure.ts';
import { extractPdfText } from '../pdf/pdf-text.ts';
import { scanSensitive, type SensitiveHit } from '../report/sensitive.ts';
import { TOOL, writeJson } from '../report/summary.ts';

export type Check = { check: string; status: 'ok' | 'warn' | 'fail'; detail: string };
export type ValidateOutput = { file: string; exitCode: ExitCodeValue; checks: Check[]; summary: string };

type Manifest = {
  schemaVersion: number;
  command: string;
  exitCode: number;
  summary: { planned: number; rendered: number; failed: number };
  combined: { file: string; pages: number } | null;
  groups?: Array<{ name: string; file: string | null; pdfPages: number }>;
  pages: Array<{ order: number; path: string; title: string; status: string; failure?: string; pdfFile: string | null; pdfPages: number; combinedStartPage: number | null }>;
};

/** manifest 폴더 밖을 가리키거나 절대 경로면 null (T-18) */
function inside(baseDir: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const full = path.resolve(baseDir, rel);
  return full.startsWith(path.resolve(baseDir) + path.sep) ? full : null;
}

export async function runValidate(manifestPath: string): Promise<ValidateOutput> {
  const baseDir = path.dirname(path.resolve(manifestPath));
  let m: Manifest;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch (e) {
    throw new Site2pdfError(ExitCode.INPUT, 'manifest-unreadable', `manifest를 읽을 수 없습니다: ${manifestPath} (${(e as Error).message})`);
  }
  if (m.schemaVersion !== 1 || m.command !== 'generate' || !Array.isArray(m.pages)) {
    throw new Site2pdfError(ExitCode.INPUT, 'manifest-invalid', `generate 결과 manifest가 아닙니다: ${manifestPath}`);
  }
  const checks: Check[] = [];
  const add = (check: string, status: Check['status'], detail: string) => checks.push({ check, status, detail });

  /** 파일을 열어 페이지 수를 확인한다. 실패하면 null */
  const pdfInfo = async (rel: string, label: string, expectPages: number): Promise<{ doc: PDFDocument; bytes: Uint8Array } | null> => {
    const full = inside(baseDir, rel);
    if (!full) {
      add(`${label}:path`, 'fail', `출력 폴더 밖 또는 절대 경로: ${rel}`);
      return null;
    }
    if (!fs.existsSync(full)) {
      add(`${label}:exists`, 'fail', `파일 없음: ${rel}`);
      return null;
    }
    try {
      const bytes = new Uint8Array(fs.readFileSync(full));
      const doc = await PDFDocument.load(bytes);
      const n = doc.getPageCount();
      add(`${label}:pages`, n === expectPages ? 'ok' : 'fail', `${rel}: ${n}쪽 (manifest ${expectPages}쪽)`);
      return { doc, bytes };
    } catch (e) {
      add(`${label}:pdf`, 'fail', `PDF로 열 수 없음(손상): ${rel} (${(e as Error).message.split('\n')[0]})`);
      return null;
    }
  };

  // 1) 페이지별 PDF: 존재·손상·쪽수·텍스트 검색 가능 (T-13, T-18)
  const rendered = m.pages.filter((p) => p.status === 'rendered');
  for (const p of rendered) {
    if (!p.pdfFile) continue;
    const info = await pdfInfo(p.pdfFile, `page#${p.order}`, p.pdfPages);
    if (info) {
      const text = await extractPdfText(info.bytes);
      add(`page#${p.order}:text`, text.text.trim().length > 0 ? 'ok' : 'fail', text.text.trim().length > 0 ? '텍스트 선택·검색 가능' : `텍스트 없음(이미지 PDF?): ${p.pdfFile}`);
    }
  }
  // 2) 출력 폴더에 manifest가 모르는 페이지별 PDF가 남아 있지 않은지
  const pagesDir = path.join(baseDir, 'pdf', 'pages');
  if (fs.existsSync(pagesDir)) {
    const known = new Set(rendered.map((p) => p.pdfFile && path.basename(p.pdfFile)));
    const stray = fs.readdirSync(pagesDir).filter((f) => f.toLowerCase().endsWith('.pdf') && !known.has(f));
    if (stray.length) add('pages:stray', 'warn', `manifest에 없는 PDF가 남아 있음: ${stray.slice(0, 5).join(', ')}`);
  }

  // 3) 통합 PDF: 쪽수 = 페이지 합, 장 시작 쪽, 북마크 순서 (T-15)
  let combinedSensitive: SensitiveHit[] = [];
  if (m.combined) {
    const total = rendered.reduce((n, p) => n + p.pdfPages, 0);
    add('combined:sum', m.combined.pages === total ? 'ok' : 'fail', `manifest 통합 ${m.combined.pages}쪽, 페이지 합 ${total}쪽`);
    const info = await pdfInfo(m.combined.file, 'combined', m.combined.pages);
    if (info) {
      let expect = 1;
      const bad = rendered.filter((p) => {
        const ok = p.combinedStartPage === expect;
        expect += p.pdfPages;
        return !ok;
      });
      add('combined:start-pages', bad.length ? 'fail' : 'ok', bad.length ? `장 시작 쪽 불일치: ${bad.map((p) => p.path).join(', ')}` : '장 시작 쪽이 순서대로 일치');
      const outline = readOutline(info.doc).map((o) => o.title);
      const titles = rendered.map((p) => p.title);
      const same = outline.length === titles.length && outline.every((t, i) => t === titles[i]);
      add('combined:outline', same ? 'ok' : 'fail', same ? `장 북마크 ${outline.length}개가 manifest 순서와 일치` : `북마크(${outline.join(' / ')})와 manifest 제목(${titles.join(' / ')}) 불일치`);
      const text = await extractPdfText(info.bytes);
      combinedSensitive = scanSensitive(text.text);
    }
  } else if (rendered.length) {
    add('combined:exists', 'warn', '통합 PDF가 없음(pdf.combined=false?)');
  }

  // 4) 그룹별 PDF
  for (const g of m.groups ?? []) {
    if (g.file) await pdfInfo(g.file, `group:${g.name}`, g.pdfPages);
    else add(`group:${g.name}`, 'warn', '해당 페이지가 없어 만들지 않음');
  }

  // 5) 민감정보 형태 문자열 (FR-15, 경고만)
  if (combinedSensitive.length) add('sensitive', 'warn', `통합 PDF에서 발견: ${combinedSensitive.map((s) => `${s.type} ${s.count}건(${s.sample})`).join(', ')}`);
  else if (m.combined) add('sensitive', 'ok', '토큰·키 형태 문자열 없음(자동 검사 기준)');

  // 6) 변환 실패 페이지 (SC-12: 성공으로 위장하지 않음)
  const failed = m.pages.filter((p) => p.status !== 'rendered');
  if (failed.length) add('pages:failed', 'warn', `변환 실패 ${failed.length}개: ${failed.map((p) => `${p.path}(${p.failure})`).join(', ')}`);
  // generate 자체가 실패로 끝났으면(탐색 단계 실패 등) 결과가 완전하지 않다
  const incomplete = failed.length > 0 || m.exitCode !== 0;
  if (m.exitCode !== 0 && !failed.length) add('generate:exit-code', 'warn', `generate 종료 코드 ${m.exitCode}: 탐색 단계 실패 등으로 일부 페이지가 빠졌을 수 있음(manifest.skipped 확인)`);

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  const exitCode: ExitCodeValue = fails ? ExitCode.SECURITY : incomplete ? ExitCode.RUN : ExitCode.OK;
  const summary = fails
    ? `검증 실패 ${fails}건 (경고 ${warns}건). 결과물을 배포하지 마세요.`
    : incomplete
      ? `파일은 manifest와 일치하지만 결과가 완전하지 않습니다(실패 페이지 ${failed.length}개, generate 종료 코드 ${m.exitCode}). 경고 ${warns}건.`
      : `검증 통과 (검사 ${checks.length}건, 경고 ${warns}건). 육안 검수는 report.md 체크리스트로 진행하세요.`;
  const file = writeJson(baseDir, 'validation.json', { schemaVersion: 1, command: 'validate', tool: TOOL, createdAt: new Date().toISOString(), manifest: path.resolve(manifestPath), exitCode, summary, checks });
  return { file, exitCode, checks, summary };
}
