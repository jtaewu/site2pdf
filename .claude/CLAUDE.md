# site2pdf 최상위 지침

승인된 웹사이트 URL 또는 로컬 정적 사이트를 안전하게 탐색해 PDF로 변환하는 범용 CLI. 특정 고객사(KICC 등) 전용이 아니다.

## 반드시 지켜야 할 지침

- 모든 응답·문서·커밋 설명은 한국어로 쓴다(코드 식별자는 영어).
- 최상위 개발 지침은 `docs/00-ai-dev-guide.md`. 충돌하면 그 문서가 우선한다.
- `docs/02-prd.md`의 요구사항만 구현한다. 범위 확장은 `docs/09-open-questions.md`에 제안하고 승인 전 개발하지 않는다.
- Phase가 끝나면 보고하고 **사용자 승인 후** 다음 Phase로 간다(`docs/08-implementation-plan.md`).
- 오버엔지니어링 금지. 사이트별 규칙은 `config/examples/`에만 두고 엔진에 하드코딩하지 않는다.
- 무단 수집·인증 우회·차단 우회 금지. `docs.kicc.co.kr`에 접근하거나 재시도하지 않는다.
- 브라우저 트래픽은 반드시 이그레스 프록시를 거친다(ADR-004). 보안 계층을 약하게 만드는 변경은 테스트와 함께 사용자 승인을 받는다.

## 디렉터리 구조

| 경로 | 내용 |
|---|---|
| `backend/` | 변환 엔진 + CLI (Node 24, TypeScript, Playwright Chromium) |
| `backend/src/` | `cli`, `config`, `fetch-policy`(URL·IP·이그레스 프록시), `local`, `browser`, `discover`, `audit`, `render`(인쇄 준비), `pdf`(링크·북마크·병합), `generate`, `validate`, `report` |
| `backend/tests/` | `unit`(네트워크 없음), `integration`(루프백 소켓), `e2e`(브라우저) |
| `frontend/` | 예약 폴더. GUI는 MVP 범위 밖 |
| `config/examples/` | 설정 예시 |
| `fixtures/` | 테스트용 사이트(정적, SPA, 보안) |
| `poc/` | Phase 0 PoC (폐기용, 재사용 금지) |
| `docs/`, `docs/adr/` | 요구사항·설계·결정 기록 |
| `output/` | 실행 결과(git 제외, `output/audit-report.md`만 추적) |

## 개발 명령 (backend/ 에서)

- `npm run browser:install`: 전용 Chromium 설치(최초 1회)
- `npm run typecheck`: 타입 검사
- `npm test`: 전체 테스트(브라우저 E2E 포함). Windows에서는 반드시 `npm test`로 실행(`scripts/vitest.mjs`가 드라이브 대소문자 문제를 피함)
- `npm run cli -- discover --source ../fixtures/static-site -o ../output`
- `npm run cli -- generate -c ../config/examples/local-static.json -o ../output` (결과 PDF는 Read 도구로 직접 열어 육안 검수)
- 저장소 루트 실행기: `site2pdf.cmd` (Windows), `./site2pdf` (sh) → `backend/scripts/cli.mjs` (Node 24 확인 후 실행)
- 원격 모드 테스트는 `tests/e2e/remote-https.test.ts` 처럼 `testOnly` 옵션(코드 전용)으로 루프백 HTTPS fixture를 쓴다. 실제 외부 사이트로 테스트하지 않는다

## 문서 목록

| 문서 | 경로 |
|---|---|
| AI 개발 최상위 지침 | `docs/00-ai-dev-guide.md` |
| 입력 진단(Phase 0) | `docs/01-source-audit.md` |
| PRD | `docs/02-prd.md` |
| 사용자 시나리오 | `docs/03-user-scenarios.md` |
| 기능·CLI·설정 명세 | `docs/04-functional-spec.md` |
| 아키텍처 | `docs/05-architecture.md` |
| 기술 설계 | `docs/06-technical-design.md` |
| 테스트·인수 계획 | `docs/07-test-plan.md` |
| 단계별 구현 계획 | `docs/08-implementation-plan.md` |
| 미결 사항·결정 기록 | `docs/09-open-questions.md` |
| ADR | `docs/adr/ADR-001~004` |
| 사용·운영 가이드 | `docs/10-user-guide.md` |
| Phase 0 진단 보고서 | `output/audit-report.md` |
