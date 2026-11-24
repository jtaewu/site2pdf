# ADR-001. 렌더링 엔진과 실행 런타임

- 상태: **승인됨** (2026-11-24, Phase 0 결정 D-01~D-15 권장안 확정)
- 날짜: 2026-11-24
- 근거: `output/audit-report.md` §3, §4.1

## 맥락
PRD FR-06~08, SC-09는 JS 렌더링 사이트까지 PDF로 만들고 텍스트를 검색할 수 있어야 한다. 05-architecture §4는 Node.js + TypeScript + Playwright + Chromium을 잠정 선택했다.

## 결정
1. **Node.js LTS + TypeScript + Playwright(Chromium)** 를 유지한다.
2. 운영·CI 실행은 **Playwright 전용 Chromium**(또는 컨테이너 이미지)을 쓴다. 사용자 PC의 시스템 Chrome/Edge는 기본값으로 쓰지 않는다.
3. 브라우저 연결은 Playwright 기본 방식(`--remote-debugging-pipe`)을 쓴다. 디버깅 TCP 포트는 열지 않는다.
4. PDF는 Chromium `page.pdf({ tagged: true, outline: true })`로 생성한다(텍스트 선택·검색, 제목 기반 북마크).

## 근거 (PoC 결과)
- 시스템 Chrome 157 + playwright-core 1.65.0으로 한글 텍스트 추출·북마크 생성을 확인했다.
- 이 PC의 Chrome/Edge는 **조직 정책으로 확장 프로그램이 강제 설치**되어 있다. Playwright 기본 인자 `--disable-extensions`를 주면 브라우저가 즉시 종료(exit 1)한다. PoC는 이 인자를 빼서 우회했지만, 그 결과 **관리 대상 확장이 렌더링 브라우저 안에서 동작**한다.
- 시스템 Chrome은 페이지와 무관한 자체 트래픽(`www.gstatic.com`, `content-autofill.googleapis.com`)을 발생시켰다. 이그레스 프록시가 이를 탐지·거부했다.
- 조직 정책·자동 업데이트로 브라우저 버전이 바뀌면 재현성(NFR)이 깨진다.

## 검토한 대안
| 대안 | 기각 사유 |
|---|---|
| wkhtmltopdf | 개발 중단, 최신 JS/CSS 미지원 |
| WeasyPrint 등 비브라우저 렌더러 | JS 미실행 → SPA(SC-09) 불가 |
| Chrome CLI `--print-to-pdf` | 요청 차단·대기 조건·북마크 제어 불가 |
| Puppeteer | 기능은 동등. 05-architecture 잠정안과 `routeWebSocket` 등 API 편의상 Playwright 유지 |

## 결과·후속
- 전용 Chromium 다운로드(약 150MB) 또는 컨테이너 사용에 **사내 승인이 필요하다**(09-open-questions Q14 → 보고서 D-04).
- 시스템 Chrome 사용은 `--channel` 같은 명시 옵션의 "개발 편의 모드"로만 남길지 결정이 필요하다.
