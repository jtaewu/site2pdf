/** CLI 종료 코드 (docs/04-functional-spec §6) */
export const ExitCode = {
  OK: 0,
  /** 입력·설정·권한 확인 실패 (접근 거부, robots 금지 포함) */
  INPUT: 2,
  /** 탐색·렌더링·변환 실패 */
  RUN: 3,
  /** 보안 정책 위반 또는 출력 검증 실패 */
  SECURITY: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class Site2pdfError extends Error {
  readonly exitCode: ExitCodeValue;
  readonly code: string;

  constructor(exitCode: ExitCodeValue, code: string, message: string) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}
