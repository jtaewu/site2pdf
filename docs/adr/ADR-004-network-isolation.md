# ADR-004. 네트워크 격리와 SSRF 방어

- 상태: **승인됨** (2026-11-24, Phase 0 결정 D-01~D-15 권장안 확정)
- 날짜: 2026-11-24
- 근거: `output/audit-report.md` §5, `output/poc/security.json`, `output/poc/egress-proxy.json`

## 맥락
00-ai-dev-guide 규칙 5·6, 06-technical-design §2, T-02~05/T-17. 렌더링 대상 페이지의 JS와 서버 응답(리다이렉트)은 신뢰할 수 없다.

## 결정 — 4단 방어
| 층 | 내용 | 막는 것 |
|---|---|---|
| L-A 입력 검증 | 원격: `https:`만 허용, userinfo 거부, 허용 포트(443), IP 리터럴·`localhost`·`*.internal` 거부, WHATWG URL 정규화 후 판정 | 잘못된 입력(T-02, T-03 일부) |
| L-B 브라우저 컨텍스트 | 모든 요청을 허용 origin 목록으로 검사(`context.route`), **서비스워커 차단**, **WebSocket 별도 차단**(`routeWebSocket`), 팝업 즉시 닫기, 다운로드 금지 | 페이지 JS의 범위 밖 요청 |
| L-C **이그레스 프록시(필수)** | 브라우저의 모든 트래픽을 로컬 정책 프록시로 보낸다(`--proxy-server`, **`--proxy-bypass-list=<-loopback>`**). 프록시는 호스트를 **한 번 해석 → IP 검사 → 그 IP로만 연결**한다 | DNS 재바인딩, 리다이렉트 이탈, 브라우저 자체 트래픽(T-04, T-05) |
| L-D OS/컨테이너 | 운영 실행은 컨테이너에서 하고, 외부 네트워크는 프록시로만 나가게 제한한다 | 위 3층을 우회하는 미지의 경로 |

로컬 모드는 원격과 **다른 정책**으로 실행한다. 루프백 정적 서버(127.0.0.1, `realpath` 기반 루트 검사)만 허용하고, 프록시는 그 외 모든 목적지를 거부한다(T-16, T-17).

## 근거 (PoC 결과: 허용 범위 밖 sentinel 서버에 실제 도달한 요청 수)
| 방어 수준 | 도달 | 새어 나간 경로 |
|---|---|---|
| 방어 없음 | 20 | css, font, img, iframe, video, fetch, beacon, SSE, WebSocket, Worker, 서비스워커 install/activate, popup, prefetch, 최상위 이동, 302 등 |
| `route`만 | 2 | **WebSocket**, **302 리다이렉트** |
| `route` + SW 차단 + WS 차단 + 팝업 | 1 | **302 리다이렉트** (route는 리다이렉트 다음 hop을 다시 검사하지 않음) |
| 직접 연결 + 앱의 사전 DNS 검증 | 1 | **DNS 재바인딩** (검증 시점 공개 IP, 연결 시점 127.0.0.1) |
| 프록시 경유: 재바인딩 / 302→루프백·메타데이터 / 공격 페이지 전체 | **0 / 0 / 0** | — |
| 프록시 사용, `<-loopback>` 없음 | 2 | Chrome이 루프백 주소를 **프록시 없이 직접 연결** |

- URL 정적 검증: `2130706433`, `0x7f.1`, `017700000001`, `[::ffff:7f00:1]`, `169.254.169.254`, `[fd00::1]`, `100.64.x` 등 22개 입력의 판정이 기대대로 나왔다.
- 남은 과제: 끝에 점이 붙은 호스트(`docs.example.com.`)는 통과했다. origin 비교 전에 정규화해야 한다.

## 결과·후속
- 프록시는 HTTP 평문(절대 URI) 요청과 `CONNECT`(HTTPS/WSS)를 처리한다. HTTPS 본문은 복호화하지 않는다. 경로 수준 정책은 L-B가 맡는다.
- 원격 모드에서 프록시가 실제 공인 DNS를 쓰는 부분은 PoC 범위 밖(가짜 DNS만 사용)이다. Phase 1에서 `dns.lookup(all)` 후 모든 주소 검사, IPv6, 타임아웃을 구현·시험한다.
- Chrome 백그라운드 트래픽 완화 플래그(`--disable-background-networking` 등)는 적용하되, 의존하지 말고 L-C로 강제한다.
- 렌더링 중 최상위 문서가 범위 밖으로 이동하면(PoC에서 `chrome-error://` 페이지로 끝남) **해당 페이지를 실패로 기록**한다. 에러 화면을 PDF로 만들지 않는다.

## Phase 3 독립 보안 감사 결과와 조치 (2026-11-24)
보안 감사 에이전트가 코드를 읽고 검토했다(동적 공격은 하지 않음). 7건 모두 조치하고 회귀 테스트를 추가했다.

| # | 등급 | 발견 | 조치 |
|---|---|---|---|
| 1 | High | **WebRTC(UDP)는 HTTP 프록시와 route를 모두 우회**: STUN으로 사설·메타데이터 주소에 UDP 전송, 로컬 모드 "외부 요청 0" 위반 가능 | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` + 컨텍스트 init script로 `RTCPeerConnection` 등 제거. 대조군(방어 없음)은 UDP 도달, site2pdf는 0건 확인 (`e2e/network-isolation.test.ts`) |
| 2 | Medium | 로그 마스킹이 대소문자 구분·http(s)만 처리 → `HTTPS://user:pw@…`, `ftp://`, fragment 토큰 노출 | 임의 스킴·대소문자 무시, 파싱 실패 시 `//…@` 통째로 가림, fragment 파라미터 마스킹, 설정 오류 메시지에도 적용 |
| 3 | Low~Med | Windows 8.3 짧은 이름(`ENV~1`, `GIT~1`)으로 숨김 파일 차단 우회 | `realpathSync.native`로 정규화 후 실제 경로 기준으로 숨김 검사 재적용 (이 PC는 8.3 활성 상태에서 시험) |
| 4 | Low | `::/96`(IPv4-compatible), `::ffff:0:0:0/96`(SIIT) 미차단 | 차단 목록 추가 |
| 5 | Low | 존 ID 주소(`fe80::1%eth0`) 처리 중 예외 → 프록시 프로세스 종료, DNS 타임아웃 없음 | 판정 전체를 예외 시 거부로 감싸고 존 ID는 비공개로 판정, DNS 10초 상한 |
| 6 | Low | 시스템 브라우저(`--browser-channel`)에서 조직 정책이 프록시 설정을 덮어쓸 가능성 | 시스템 브라우저일 때 시작 전에 실제로 프록시를 거치는지 확인, 아니면 보안 오류(4)로 중지 |
| 7 | Low | 로컬 정적 서버가 Host 헤더를 검사하지 않음(다른 브라우저의 DNS 재바인딩) | `Host: 127.0.0.1:<port>`만 허용, 그 외 421 |

남은 운영 권고: L-D(컨테이너·방화벽으로 프록시 외 egress 차단)는 코드가 아닌 실행 환경 설정이므로 `docs/10-user-guide.md` §5에 운영 지침으로 둔다.
