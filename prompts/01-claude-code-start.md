# Claude Code 최초 실행 프롬프트 — Phase 0

이 저장소는 **site2pdf**라는 범용 웹사이트→PDF 변환기야. KICC 전용 프로그램이 아니며, KICC는 추후 첫 적용 사례야.

1. `docs/00-ai-dev-guide.md`를 최상위 지침으로 삼아.
2. `README.md`, `docs/01-source-audit.md`~`docs/09-open-questions.md`를 전부 순서대로 읽어.
3. **현재는 Phase 0만 실행해.** 정적 HTML과 SPA fixture 기반으로 탐색 방식/HTML→PDF/병합/목차 가능성을 PoC 해.
4. 아무 웹사이트나 크롤링하지 마. `docs.kicc.co.kr` 차단을 우회하거나 접근을 반복 시도하지 마. 권한 있는 테스트 URL이나 로컬 자료만 사용해.
5. 특히 SSRF, DNS 재바인딩, 리다이렉트, 서비스워커/외부 리소스 접근 위험을 분석하고 안전한 격리 실행안을 제시해.
6. 코어 로직에 KICC 도메인/프레임워크/메뉴명을 하드코딩하지 마.
7. 산출: `output/audit-report.md`, PoC 결과, ADR, 미확정 사항, Phase 1 구현 전 필요한 사용자 결정 목록.
8. Phase 0 보고서 제출 후 **승인 전 Phase 1 구현 금지**. 한국어로 보고해.

테스트용 로컬 소스: [경로를 기입하거나 fixture를 자체 생성]
승인된 원격 테스트 URL(선택): [없으면 원격 테스트 생략]
