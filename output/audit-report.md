# site2pdf Phase 0 진단 보고서

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-11-24 |
| 단계 | Phase 0: 설계 확인 및 PoC |
| 입력 | 자체 생성 fixture만 사용 (원격 테스트 URL 없음 → 원격 테스트 생략) |
| 실행 환경 | Windows 11, Node v24.16.0, Chrome 157.0.8103.79(시스템, 조직 관리), playwright-core 1.65.0, pdf-lib 1.17.1, pdfjs-dist 4.10.38 |
| 상태 | **사용자 검토·승인 대기. 승인 전 Phase 1 구현 금지** |

---

## 1. 결론

1. **기술적으로 MVP는 가능하다.** 정적 HTML과 SPA fixture에서 탐색 → 페이지별 PDF → 통합 PDF(2단계 북마크·내부 링크)까지 동작했다. 한글 텍스트 선택·검색도 된다.
2. **브라우저 수준 차단만으로는 SSRF를 막을 수 없다.** 서버측 302 리다이렉트와 DNS 재바인딩이 새어 나갔다. **이그레스 프록시**를 두면 모두 0건으로 막혔다. 프록시는 MVP 필수 구성으로 제안한다(ADR-004).
3. **실행 브라우저는 시스템 Chrome이 아닌 전용 Chromium**을 권장한다. 이 PC의 Chrome/Edge는 조직 정책(확장 강제 설치) 때문에 Playwright 기본 설정으로는 시작되지 않는다(F-01).
4. **사이트별 설정 3종**(`contentSelector`, `readySelector`, `hideSelectors`)이 없으면 SPA 로딩 실패를 놓치거나 사이드바 여백 때문에 페이지가 늘어난다. 현재 PRD·스펙에 없는 항목이라 **범위 변경 승인이 필요**하다(D-08).
5. **KICC 관련 진단은 하지 않았다.** `docs.kicc.co.kr`에는 접근하지 않았다. 권한·기술 스택·규모는 모두 미확인이다.

---

## 2. 입력 진단표 (01-source-audit 양식)

| 항목 | 결과 |
|---|---|
| 권한 | **미확인.** 첫 실제 대상(KICC 포함)의 수집·복제 승인 정보 없음 |
| 입력 유형 | PoC는 로컬 fixture를 루프백 서버로 제공. 실제 대상은 미정(D-02) |
| 사이트 구조 | fixture 3종: 정적 HTML(계층 메뉴·상대 경로), SPA(History 라우팅·700ms 지연 렌더·무한 로딩 라우트), 보안 공격 페이지 |
| 탐색 가능성 | 정적: `<a href>`로 전부 발견, sitemap은 6개 중 3개만 포함. SPA: 브라우저 렌더링 후에만 링크 발견 |
| 경계 | origin + path prefix(세그먼트 경계) + deny 패턴 + 다운로드 확장자 + 리다이렉트 후 재판정으로 동작 확인 |
| 페이지 수 | fixture 5~6페이지. 쿼리 연쇄(`?page=N`)는 쿼리 제거 정책이 없으면 maxDepth까지 증식 |
| 내용 | 한글, 90줄 코드, 6열×25행 표, 1600px SVG, 외부 이미지, iframe/video 포함 |
| 리소스 | 외부 이미지·CSS·폰트는 기본 차단 시 깨진 이미지로 출력(경고 대상) |
| 로봇 정책 | fixture에 `robots.txt` 존재. 판정 로직은 PoC 범위 밖(Phase 1) |
| 민감 정보 | 본문의 가짜 토큰(`FIXTURE_FAKE_TOKEN_DO_NOT_LOG`)이 **PDF에 그대로 출력됨**. 로그·manifest 노출 여부는 Phase 1에서 시험(T-20) |

---

## 3. 환경 진단 결과

| ID | 발견 | 영향 | 조치/제안 |
|---|---|---|---|
| F-01 | 시스템 Chrome·Edge에 조직 정책 `ExtensionInstallForcelist`가 있다. Playwright 기본 인자 `--disable-extensions`를 주면 **즉시 exit 1**한다(오류 메시지 없음) | 기본 설정으로 브라우저 구동 불가 | PoC는 `ignoreDefaultArgs: ['--disable-extensions']`로 우회. 대신 관리 확장이 렌더링에 개입할 수 있다 → 전용 Chromium 권장(D-04) |
| F-02 | 시스템 Chrome이 `www.gstatic.com`, `content-autofill.googleapis.com`으로 자체 트래픽을 보냈다 | 오프라인 모드(T-17) 위반 가능, 재현성 저하 | 이그레스 프록시가 탐지·거부. 전용 Chromium + 백그라운드 네트워크 차단 플래그 |
| F-03 | Windows에서 심볼릭 링크 생성은 `EPERM`(관리자/개발자 모드 필요), junction은 일반 권한으로 생성된다 | T-16 테스트를 junction으로 대체해야 함 | 로컬 서버는 `realpath` 기반 검사로 junction 탈출까지 차단 확인 |
| F-04 | `.claude/CLAUDE.md`, `README.md`가 이전 템플릿 내용(백엔드/프론트엔드 구조, 옛 문서 경로)을 가리킨다 | 에이전트가 잘못된 지침을 읽을 위험 | 갱신 승인 요청(D-13) |

---

## 4. PoC 결과

PoC 코드는 `poc/`에 있으며 **Phase 1에서 재사용하지 않는 폐기용 코드**다. 재현: `cd poc && npm install && node run-all.mjs`(약 3.5분). 결과는 `output/poc/*.json`과 `output/poc/pdf/`에 생성된다.

### 4.1 탐색 (`poc/01-discover.mjs`) → ADR-002

| 시나리오 | 결과 |
|---|---|
| 정적, HTTP 파싱, 쿼리 유지 | 8페이지. `list.html?page=1→2→3` 연쇄가 maxDepth(3)에서 멈춤(`?page=4`는 maxDepth 제외) |
| 정적, HTTP 파싱, 쿼리 제거 | 6페이지, 317ms. `utm_source` 링크는 원본과 중복으로 합쳐짐 |
| 정적, 브라우저 DOM, 쿼리 제거 | 6페이지, 10.7s(페이지당 약 1.1s). HTTP 방식과 같은 목록 |
| 범위 밖 링크 | 외부 도메인, `/logout`, `/admin/`, `/docs/private/`, `mailto:`, `javascript:`, `.zip` 7종 모두 사유와 함께 제외 |
| 시작 URL이 다른 호스트로 302 | `blocked-after-redirect (origin-out-of-scope)` 기록 |
| SPA, HTTP 파싱 | **1페이지(링크 0개)**. SPA에는 사용 불가 |
| SPA, 브라우저 DOM | 4라우트 발견, 외부 링크 제외 |
| SPA 무한 로딩 라우트(`/app/slow`) | **범용 대기 조건이 "안정"으로 오판**(본문 "로딩 중..." 7자). 별도 판정 규칙 필요 |

### 4.2 렌더링 (`poc/02-render.mjs`) → ADR-003

텍스트 커버리지 = 화면 DOM의 단어 중 PDF 텍스트에 존재하는 비율. 가로 넘침 = A4 인쇄 폭(687px)을 넘는 요소 수.

| 페이지 | v1 그대로 | v2 범용 인쇄 CSS + 고정 요소 숨김 | v3 v2 + `contentSelector: main` |
|---|---|---|---|
| install(긴 명령어) | 커버리지 0.90, 넘침 1 | 1.0 / 0 | 1.0 / 0 |
| reference(90줄 코드, 넓은 표) | 커버리지 **0.927**, 넘침 2, 2p | 1.0 / 0, 8p | 1.0 / 0, **6p** |
| intro(1600px 이미지) | 커버리지 1.0, **넘침 1** | 1.0 / 0 | 1.0 / 0 |
| SPA `/app/guide` | 1.0 / 0 | 1.0 / 0 | 1.0 / 0 |
| SPA `/app/slow` | "로딩 중..."이 그대로 PDF로 출력 | 동일 | **`contentSelector-not-found`로 실패 탐지** |

- 페이지당 렌더 시간은 1.6~2.9초다.
- 두 자동 검사는 서로 보완한다. 이미지 잘림은 커버리지로는 안 잡히고 넘침 검사로만 잡혔다.

### 4.3 육안 검수 (대표 PDF 2종)

| 파일 | 확인 결과 |
|---|---|
| `output/poc/pdf/v1-as-is/005-docs-api-reference-html.pdf` | 코드 줄 끝·표 오른쪽 열 잘림. **고정 헤더가 2페이지 상단 코드 4줄(line76~79)을 가림** → PDF 텍스트에는 남아 있어 **자동 검사로 탐지 불가** |
| `output/poc/pdf/merge/B-single-html.pdf` (10p) | 한글·코드 줄바꿈 정상. 표 헤더가 페이지마다 반복됨. 표는 폭 안에 들어오지만 `E1/0`, `코/드`처럼 **글자 단위로 끊겨 가독성 저하**. 차단된 외부 이미지는 깨진 아이콘 + alt로 표시 |

**결론: 자동 검사는 잘림의 일부만 잡는다. 겹침·가독성은 육안 검수가 필수다**(00-ai-dev-guide 규칙 10과 일치).

### 4.4 통합 PDF (`poc/03-merge.mjs`) → ADR-003

| 항목 | A: 페이지별 PDF → pdf-lib 병합 | B: 단일 HTML 1회 인쇄 |
|---|---|---|
| 페이지 / 크기 | 10p / 169KB | 10p / 161KB |
| 북마크 | 11개, 2단계(장=페이지 h1, 하위=h2) | 11개, 2단계 |
| 내부 링크 | 5개(URI → GoTo 변환, **페이지 첫 장으로 이동**) | 5개(**앵커 위치까지 정확**) |
| 범위 밖 링크 | 7개가 원래 URL 그대로 남음 | 동일 |

**새 이슈:** 제외한 페이지(`/admin/`, `/docs/private/secret.html`)로 가는 링크가 PDF에 URL로 남는다. 내부 주소가 노출될 수 있다(D-10).

### 4.5 보안 (`poc/04-security.mjs`, `poc/05-egress-proxy.mjs`, `poc/06-local-boundary.mjs`) → ADR-004

공격 페이지(`fixtures/security-site/attack.html`)와 서버측 302 경로는 허용 origin 밖 sentinel 서버로 16가지 방식의 요청을 시도한다(prefetch, CSS, CSS 배경, 웹폰트, img, iframe, video, fetch, beacon, SSE, WebSocket, popup, 서비스워커, Worker, 최상위 이동, 302). 측정값은 **sentinel에 실제로 도달한 요청 수**다. 모든 통신은 로컬 루프백 안에서만 이뤄졌다.

| 방어 구성 | 도달 | 새어 나간 경로 |
|---|---|---|
| 없음 | 20 | 전 경로(서비스워커 install/activate, Worker, beacon, SSE, WebSocket, popup, 최상위 이동, 302 포함) |
| `context.route` 허용 목록만 | 2 | WebSocket, 302 리다이렉트 |
| route + 서비스워커 차단 + WebSocket 차단 + 팝업 닫기 | **1** | **302 리다이렉트** |
| 프록시 없이 직접 연결, 앱이 미리 DNS 검증 | **1** | **DNS 재바인딩**(검증 시 93.184.216.34 → 연결 시 127.0.0.1) |
| 이그레스 프록시 경유: 재바인딩 | **0** | 프록시가 127.0.0.1로 해석·거부 |
| 이그레스 프록시 경유: 302 → 127.0.0.1 / 169.254.169.254 | **0** | 두 경우 모두 거부 |
| 이그레스 프록시 + 브라우저 방어, 공격 페이지 전체 | **0** | — |
| 프록시 사용, `--proxy-bypass-list=<-loopback>` 누락 | 2 | **Chrome이 루프백은 프록시를 거치지 않음** |

URL 정적 검증 22건과 IP 판정 21건은 모두 기대대로 나왔다(10진수·16진수·8진수 IP 표기, IPv4-mapped IPv6, NAT64, CGNAT, 메타데이터 주소 포함). 단, 끝에 점이 붙은 호스트명(`docs.example.com.`)은 정규화 대상으로 남았다.

로컬 파일 경계는 11건 모두 차단됐다(`../`, `%2e%2e`, `%2f`, `..%5c`(역슬래시), 드라이브 경로, NUL, junction). 인코딩 우회와 junction은 **`realpath` 검사에서만 막혔다**. 경로 문자열 비교만으로는 부족하다.

---

## 5. 위험 분석과 안전한 격리 실행안

### 5.1 위험별 분석

| 위험 | 공격 경로 | PoC 결과 | 대응 |
|---|---|---|---|
| SSRF(직접) | 입력 URL·페이지 내 링크/리소스가 사설 IP, 루프백, 메타데이터를 가리킴 | 입력 검증 + route로 차단 | L-A, L-B |
| SSRF(리다이렉트) | 허용 origin 응답의 302가 내부 주소로 이동 | **route로는 못 막음** | L-C 프록시(필수) |
| DNS 재바인딩 | 검증 시점과 연결 시점의 DNS 응답이 다름 | **사전 검증으로는 못 막음** | L-C 프록시: 해석·검사·연결을 하나의 IP로 처리 |
| 서비스워커 | SW가 페이지 밖에서 요청 발생, route 우회 | `serviceWorkers: 'block'`으로 차단 | L-B |
| WebSocket | route가 가로채지 않음 | `routeWebSocket`으로 차단 | L-B + L-C |
| 외부 리소스(CDN·폰트·이미지) | 추적, 내부망 탐색, 렌더링 결과 변동 | 차단 시 깨진 이미지·대체 폰트로 출력 | 기본 차단 + 설정 허용 목록(D-09) |
| 최상위 이동·팝업 | JS가 범위 밖으로 이동 | 이동은 막히지만 **에러 페이지가 남음** | 최종 URL·상태 검사로 페이지 실패 처리(D-14) |
| 브라우저 자체 트래픽 | 확장·자동완성·업데이트 | 시스템 Chrome에서 실제 발생 | 전용 Chromium + 프록시 |
| 로컬 파일 탈출 | `../`, 인코딩, 심볼릭 링크/junction | `realpath` 검사로 전부 차단 | 로컬 서버 루트 고정 |
| 디버깅 포트 노출 | `--remote-debugging-port` 사용 시 로컬 프로세스·페이지가 접근 가능 | PoC 중간에 포트 방식을 시도했다가 폐기 | pipe 방식 유지(ADR-001) |

### 5.2 권장 실행 구성 (원격 모드)

```text
[site2pdf CLI] ── 입력 검증(L-A) ──┐
                                    ▼
          ┌────────── 컨테이너 / 전용 실행 계정 (L-D) ──────────┐
          │  Chromium(전용, pipe 연결, 확장·백그라운드 네트워크 끔)  │
          │   └ BrowserContext: route 허용목록, SW 차단, WS 차단,   │
          │     팝업 닫기, 다운로드 금지 (L-B)                      │
          │        │ --proxy-server, --proxy-bypass-list=<-loopback>│
          │        ▼                                               │
          │  이그레스 프록시 (L-C): DNS 1회 해석 → IP 검사 → 그 IP로 연결│
          └────────────────────────┬───────────────────────────────┘
                                   ▼  (컨테이너 egress는 프록시 경유만 허용)
                              승인된 HTTPS origin
```

### 5.3 로컬 모드

`--source` 디렉터리를 127.0.0.1 임의 포트의 읽기 전용 정적 서버로 제공한다(`realpath` 루트 검사, 디렉터리 목록 없음). 프록시는 이 서버 외 **모든 목적지를 거부**한다. `file://` 직접 열기는 `/assets/...` 같은 루트 상대 경로가 드라이브 루트로 해석되는 문제가 있어 권장하지 않는다(분석, 미시험).

---

## 6. 테스트 계획(07) 사전 검증 매핑

| ID | Phase 0 상태 | 비고 |
|---|---|---|
| T-02, T-03 | 정책 함수로 확인 | 정식 단위 테스트는 Phase 1 |
| T-04 | 프록시 경유 시 차단 확인 | 브라우저 방어만으로는 실패 |
| T-05 | 가짜 DNS로 시뮬레이션, 프록시로 차단 확인 | 실제 DNS 경로는 Phase 1 |
| T-06, T-07 | 확인 | 쿼리 기본 정책 결정 필요(D-06) |
| T-08 | 미시험 | robots·401/403·캡차 fixture는 Phase 1 |
| T-11, T-12, T-13, T-15 | 확인(fixture) | 표 가독성 튜닝 필요 |
| T-14 | 외부 이미지 차단만 확인 | iframe/video 출력 정책 미정(Q11) |
| T-16 | junction으로 확인 | symlink는 권한 문제로 미시험 |
| T-17 | 프록시로 외부 요청 0건 확인 | 시스템 Chrome 자체 트래픽 존재 |
| T-01, T-09, T-10, T-18~20 | 미시험 | Phase 1~3 |

---

## 7. 변경 파일

| 경로 | 내용 |
|---|---|
| `fixtures/static-site/` | 정적 문서 fixture (계층 메뉴, 한글, 90줄 코드, 넓은 표, 1600px SVG, 범위 밖 링크, 쿼리 연쇄, robots, sitemap) |
| `fixtures/spa-site/` | History 라우팅 SPA fixture (지연 렌더, 무한 로딩 라우트) |
| `fixtures/security-site/` | 범위 밖 요청 시도 페이지, 서비스워커 |
| `poc/` | PoC 스크립트 6종 + 공통 lib + `run-all.mjs` (폐기용) |
| `docs/adr/ADR-001~004` | 런타임, 탐색, 렌더링·병합, 네트워크 격리 |
| `docs/09-open-questions.md` | Phase 0 추가 질문 D-xx 연결 |
| `docs/08-implementation-plan.md` | Phase 0 체크리스트 진행 표시 |
| `.gitignore` | `output/` 무시(이 보고서는 예외로 추적) |

---

## 8. 미확정 사항

| ID | 내용 |
|---|---|
| U-01 | 첫 실제 대상 사이트와 수집·복제 권한(KICC 포함) |
| U-02 | KICC 문서의 기술 스택, 규모, 로컬 빌드 제공 가능 여부 |
| U-03 | 원격 모드 실제 DNS 해석 경로(다중 A/AAAA, IPv6 우선순위)에서의 프록시 동작 |
| U-04 | 표 셀 줄바꿈 규칙의 범용 기본값(가독성 vs 잘림 방지) |
| U-05 | A 방식 병합에서 앵커 단위 내부 링크 구현 가능성 |
| U-06 | robots.txt 판정 세부 규칙(User-agent 이름, 파싱 실패 시 동작) |
| U-07 | 수백 페이지 규모의 처리 시간·메모리(측정 안 함) |
| U-08 | iframe/video/canvas/탭/아코디언 콘텐츠 출력 범위(Q11) |

---

## 9. Phase 1 착수 전 사용자 결정 목록

권장안을 먼저 적었다. 범위가 바뀌는 항목(★)은 PRD/스펙 수정이 필요하다.

| ID | 결정할 내용 | 권장안 |
|---|---|---|
| D-01 | 첫 테스트 대상과 권한 (Q1, Q5) | Phase 1은 fixture만으로 진행. KICC는 담당자에게 로컬 정적 빌드를 요청 |
| D-02 | 입력 우선순위 (Q2) | 둘 다 설계하되 **로컬 모드를 먼저 완성**(KICC 차단 상황에 맞음) |
| D-03 | 기본 제한값 (Q3) | `maxPages 200`, `maxDepth 5`, `minDelayMs 1000`, 동시성 1, 페이지 타임아웃 15초 |
| D-04 | 실행 브라우저·설치 승인 (Q14) | Playwright 전용 Chromium 사용(약 150MB 다운로드 승인 필요). 시스템 Chrome은 명시 옵션으로만 허용 |
| D-05 | 탐색 방식 | 브라우저 DOM 탐색 단일화, sitemap은 보조(ADR-002) |
| D-06 | 쿼리 URL 중복 판정 (Q7) | 기본 제거 + 설정의 허용 파라미터 목록 |
| D-07 | 병합 방식, 북마크 우선순위 (Q10) | A 방식(pdf-lib) 채택. FR-10 북마크는 Should 유지하되 Phase 2에 포함 |
| D-08 ★ | 사이트별 렌더 설정 `contentSelector`·`readySelector`·`hideSelectors` 추가 (Q9) | 추가. 코어 하드코딩 없이 `config/examples/`에만 사례 기재 |
| D-09 | 외부 리소스(CDN·폰트·이미지) 정책 (Q8) | 기본 차단 + origin 단위 허용 목록(보안 검토 후), 차단 내역은 manifest 경고 |
| D-10 | PDF 안 범위 밖 링크 처리 (Q12) | 포함 페이지 링크는 내부 이동으로 변환. 외부 링크는 유지. **제외 페이지 링크는 링크를 제거하고 텍스트만 남김**(내부 주소 노출 방지) |
| D-11 ★ | 이그레스 프록시를 MVP 필수 구성으로 포함 | 포함(ADR-004). 운영 실행은 컨테이너 권장(L-D) |
| D-12 ★ | 본문 민감정보(토큰 형태 문자열) 처리 | MVP는 PDF 내용을 바꾸지 않고 **탐지 시 경고만** 보고서에 기록 |
| D-13 | `.claude/CLAUDE.md`, `README.md`를 현재 문서 체계에 맞게 갱신 | 갱신 |
| D-14 | 페이지 실패 판정 기준 (SC-09, SC-12) | 최종 응답 비2xx, 최종 URL 범위 밖, 최상위 문서 이동/에러 페이지, `readySelector`/`contentSelector` 미발견, 본문 텍스트가 임계값 미만이면 실패 |
| D-15 | 표 줄바꿈 기본값 | 셀 단위 `overflow-wrap: break-word`(단어 우선) + 넘치면 표 축소, 육안 검수로 확정 |
