# Claude Code 구현 프롬프트 — 단계별 개발

Phase 0 진단과 사용자 승인을 마쳤다는 전제로 진행해.

- 프로젝트명은 `site2pdf`; 특정 웹사이트 전용으로 만들지 마.
- `docs/00-ai-dev-guide.md`, `docs/02-prd.md`, `docs/04-functional-spec.md`, `docs/05-architecture.md`, `docs/07-test-plan.md`, `docs/08-implementation-plan.md`를 순서대로 읽어.
- **Phase 1만 먼저 구현해**: CLI, 입력 검증, 안전한 링크 탐색, 사이트 경계 및 속도/개수 제한, 보안 테스트, 발견 목록 파일.
- 외부/사설 IP 접근, 차단 우회, 로그인 자동화, 웹 UI, DB, 스케줄러, SaaS 기능을 추가하지 마.
- 테스트 픽스처와 T-01~T-10을 구현하고 결과를 알려줘. 모호한 요구는 임의 구현하지 말고 `docs/09-open-questions.md`에 남겨.
- 수정 파일/명령/테스트 결과/실패 위험을 한국어로 보고하고 승인 전 다음 Phase로 가지 마.

Phase 0 보고서: [경로]
승인된 테스트 사이트/설정: [URL 또는 로컬 폴더]
