import { describe, expect, it } from 'vitest';
import { pageFileName, slugify } from '../../src/pdf/filename.ts';
import { planPages } from '../../src/generate/plan.ts';

describe('T-18(일부) 파일명 정제', () => {
  it.each([
    ['API 레퍼런스', 'API-레퍼런스'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
    ['../../etc/passwd', 'etc-passwd'],
    ['   ', 'page'],
    ['CON', 'page-CON'],
    ['nul', 'page-nul'],
    ['끝에 점...', '끝에-점'],
    ['탭\t줄바꿈\n제어\u0007문자', '탭-줄바꿈-제어-문자'],
  ])('%j → %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('긴 제목은 60자로 자르고 인덱스로 충돌을 막는다', () => {
    const long = '가'.repeat(100);
    expect([...slugify(long)].length).toBe(60);
    expect(pageFileName(7, long)).toMatch(/^007-가{60}\.pdf$/);
    expect(pageFileName(1, '같은 제목')).not.toBe(pageFileName(2, '같은 제목'));
  });
});

describe('변환 대상 확정 (SC-03, SC-04, T-10, T-15)', () => {
  const O = 'https://site.test';
  const scope = { allowedOrigins: [O], pathPrefixes: ['/docs'], denyPatterns: ['/admin'] };
  const q = { policy: 'drop' as const, keepParams: [] };
  const c = (order: number, path: string, extra: Record<string, unknown> = {}) => ({ order, path, status: 'ok', selected: true, title: path, ...extra });

  it('성공·선택된 페이지만 발견 순서대로, 나머지는 사유와 함께 제외', () => {
    const plan = planPages(
      [c(3, '/docs/c'), c(1, '/docs/a'), c(2, '/docs/b', { selected: false, selectionReason: 'selection-exclude:/docs/b' }), c(4, '/docs/d', { status: 'failed', failure: 'http-404' })],
      O, scope, q, [],
    );
    expect(plan.pages.map((p) => p.path)).toEqual(['/docs/a', '/docs/c']);
    expect(plan.skipped).toEqual([
      { path: '/docs/b', reason: 'selection-exclude:/docs/b' },
      { path: '/docs/d', reason: 'discover-failed:http-404' },
    ]);
  });

  it('수정된 목록이 범위를 넓히지 못한다 (범위 밖·중복 재검증)', () => {
    const plan = planPages([c(1, '/docs/a'), c(2, '/admin/x'), c(3, '/blog/y'), c(4, '/docs/a#top'), c(5, '/docs/a?utm_source=x')], O, scope, q, []);
    expect(plan.pages.map((p) => p.path)).toEqual(['/docs/a']);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['out-of-scope:path-out-of-scope', 'out-of-scope:path-out-of-scope', 'duplicate', 'duplicate']);
  });

  it('selection.order 경로를 앞으로, 없는 경로는 보고', () => {
    const plan = planPages([c(1, '/docs/a'), c(2, '/docs/b'), c(3, '/docs/c')], O, scope, q, ['/docs/c', '/docs/zzz', '/docs/a']);
    expect(plan.pages.map((p) => p.path)).toEqual(['/docs/c', '/docs/a', '/docs/b']);
    expect(plan.orderNotFound).toEqual(['/docs/zzz']);
  });
});

describe('텍스트 커버리지 (보이지 않는 문자 오탐 방지)', () => {
  it('제목 끝 제로폭 공백(U+200B)·이모지 변형 선택자는 누락으로 보지 않는다', async () => {
    const { textCoverage } = await import('../../src/pdf/pdf-text.ts');
    expect(textCoverage(['요청​', '파라미터​', '🛡️'], '요청 파라미터 🛡')).toEqual({ ratio: 1, missing: [] });
    expect(textCoverage(['요청', '없는단어'], '요청')).toEqual({ ratio: 0.5, missing: ['없는단어'] });
  });
});
