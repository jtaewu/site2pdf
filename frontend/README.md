# frontend (예약 폴더)

향후 GUI(웹 화면)를 둘 자리입니다. **MVP 범위 밖**이라 현재 코드는 없습니다.

- MVP는 CLI 전용입니다(`docs/00-ai-dev-guide.md` 규칙 8, `docs/02-prd.md` §7 MVP 제외).
- GUI를 추가하려면 먼저 PRD 변경과 사용자 승인을 받아야 합니다. GUI는 웹 서버를 동반하므로 인증·SSRF·업로드 등 보안 범위가 함께 커집니다.
- 변환 엔진은 `backend/`에 있습니다. GUI가 생기면 엔진을 직접 다시 구현하지 말고 `backend`의 공개 함수(`runAudit`, `runDiscover` 등)를 호출하는 방식으로 붙입니다.
