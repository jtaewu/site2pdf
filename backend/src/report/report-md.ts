// 사람이 읽는 결과 보고서 report.md (06-technical-design §4, 07-test-plan §3 육안 검수 체크리스트)
import fs from 'node:fs';
import path from 'node:path';
import { maskText } from './mask.ts';

type Page = {
  order: number; path: string; title: string; status: string; failure?: string; pdfFile: string | null;
  pdfPages: number; combinedStartPage: number | null; warnings: string[]; qa: { coverage: number } | null;
  sensitive?: Array<{ type: string; count: number; sample: string }>;
};
type Manifest = {
  createdAt: string; exitCode: number; message: string; mode: string; input: Record<string, unknown>;
  tool: { name: string; version: string };
  summary: { planned: number; rendered: number; failed: number; skipped: number; warnings: number };
  combined: { file: string; pages: number; outlineEntries: number; links: Record<string, number> } | null;
  groups?: Array<{ name: string; title: string; file: string | null; pages: string[]; pdfPages: number }>;
  pages: Page[]; skipped: Array<{ path: string; reason: string }>;
  blockedRequests: Array<{ type: string; origin: string; count: number }>;
  egressDenied: Array<{ target: string; reason: string; count: number }>;
};

const esc = (s: string) => maskText(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderReportMd(m: Manifest): string {
  const status = m.exitCode === 0 ? '성공' : `**실패 포함 (종료 코드 ${m.exitCode})**`;
  const lines = [
    '# site2pdf 변환 보고서',
    '',
    `| 항목 | 값 |`,
    `|---|---|`,
    `| 결과 | ${status} |`,
    `| 요약 | ${esc(m.message)} |`,
    `| 입력 | ${m.mode} ${esc(JSON.stringify(m.input))} |`,
    `| 생성 | ${m.createdAt} (${m.tool.name} ${m.tool.version}) |`,
    `| 페이지 | 계획 ${m.summary.planned} / 성공 ${m.summary.rendered} / 실패 ${m.summary.failed} / 제외 ${m.summary.skipped} |`,
    `| 경고 | ${m.summary.warnings}건 |`,
    m.combined
      ? `| 통합 PDF | \`${m.combined.file}\` ${m.combined.pages}쪽, 북마크 ${m.combined.outlineEntries}개, 내부 링크 ${m.combined.links.gotos}개(앵커 정확 ${m.combined.links.anchorExact}), 제거 ${m.combined.links.removed}, 외부 유지 ${m.combined.links.kept} |`
      : '| 통합 PDF | 생성 안 함 |',
    '',
    '## 페이지',
    '',
    '| # | 제목 | 경로 | 상태 | 통합 PDF 시작쪽 | 쪽수 | 텍스트 커버리지 | 경고 |',
    '|---|---|---|---|---|---|---|---|',
    ...m.pages.map((p) =>
      `| ${p.order} | ${esc(p.title)} | \`${esc(p.path)}\` | ${p.status === 'rendered' ? '성공' : `실패: ${esc(p.failure ?? '')}`} | ${p.combinedStartPage ?? '-'} | ${p.pdfPages || '-'} | ${p.qa ? p.qa.coverage : '-'} | ${esc(p.warnings.join(', ')) || '-'} |`,
    ),
  ];
  if (m.groups?.length) {
    lines.push('', '## 그룹별 PDF', '', '| 그룹 | 파일 | 쪽수 | 페이지 수 |', '|---|---|---|---|');
    for (const g of m.groups) lines.push(`| ${esc(g.name)} | ${g.file ? `\`${g.file}\`` : '만들지 않음(해당 페이지 없음)'} | ${g.pdfPages || '-'} | ${g.pages.length} |`);
  }
  const sens = m.pages.filter((p) => p.sensitive?.length);
  if (sens.length) {
    lines.push('', '## 민감정보로 보이는 문자열 (PDF 내용은 바꾸지 않음)', '', '외부 배포 전에 실제 비밀값인지 확인하세요. 표본은 앞 6자만 표시합니다.', '', '| # | 경로 | 종류 | 건수 | 표본 |', '|---|---|---|---|---|');
    for (const p of sens) for (const s of p.sensitive!) lines.push(`| ${p.order} | \`${esc(p.path)}\` | ${s.type} | ${s.count} | \`${s.sample.replace(/`/g, '')}\` |`);
  }
  if (m.skipped.length) {
    lines.push('', '## 변환 대상에서 제외', '', '| 경로 | 사유 |', '|---|---|', ...m.skipped.map((s) => `| \`${esc(s.path)}\` | ${esc(s.reason)} |`));
  }
  if (m.blockedRequests.length || m.egressDenied.length) {
    lines.push('', '## 차단된 요청 (누락 리소스 가능성)', '', '| 유형 | 대상 | 건수 |', '|---|---|---|');
    for (const b of m.blockedRequests) lines.push(`| ${b.type} | ${esc(b.origin)} | ${b.count} |`);
    for (const e of m.egressDenied) lines.push(`| egress:${e.reason} | ${esc(e.target)} | ${e.count} |`);
  }
  lines.push(
    '',
    '## 경고 의미',
    '',
    '- `horizontal-overflow`: 인쇄 폭을 넘는 요소가 남음 → 오른쪽 잘림 가능',
    '- `text-coverage:x`: 화면 텍스트 중 PDF에 없는 단어 비율이 1% 이상 → 잘림·누락 가능',
    '- `unsupported-content:태그`: iframe·video·canvas 등은 인쇄 결과가 화면과 다를 수 있음',
    '- `blocked-requests:n`: 범위 밖 리소스 차단 → 이미지·글꼴 누락 가능',
    '- `duplicate-title`: 같은 장 제목이 여러 번 나옴 → 북마크 구분 어려움',
    '- `sensitive-content:종류`: 토큰·키처럼 보이는 문자열 → 외부 배포 전 확인',
    '- `iframe-expanded:n`: 같은 사이트 iframe을 내용 높이만큼 펼쳐 인쇄함 → 쪽 나눔 확인',
    '- `retried:n`: 일시적 실패 후 재시도해 성공함',
    '',
    '## 육안 검수 체크리스트 (자동 검사로 보장되지 않음)',
    '',
    '- [ ] 발견·선택·최종 포함 페이지 수와 순서가 위 표와 일치',
    '- [ ] 제목·한글·코드·표·이미지 잘림 없음, 고정 헤더 등이 본문을 가리지 않음',
    '- [ ] PDF 텍스트 선택·검색 가능',
    '- [ ] 북마크로 장 이동 가능, 내부 링크가 올바른 위치로 이동',
    '- [ ] 경고가 있는 페이지를 직접 열어 확인',
    '- [ ] 외부 배포 전 저작권·민감정보 검수 완료',
    '',
  );
  return lines.join('\n');
}

export function writeReportMd(outputDir: string, manifest: unknown): string {
  const file = path.join(outputDir, 'report.md');
  fs.writeFileSync(file, renderReportMd(manifest as Manifest), 'utf8');
  return file;
}
