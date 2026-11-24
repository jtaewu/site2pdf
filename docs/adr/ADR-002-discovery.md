# ADR-002. 하위 페이지 탐색 방식

- 상태: **승인됨** (2026-11-24, Phase 0 결정 D-01~D-15 권장안 확정)
- 날짜: 2026-11-24
- 근거: `output/audit-report.md` §4.2, `output/poc/discover.json`

## 맥락
FR-03/04, SC-02/07/09. 정적 HTML과 클라이언트 렌더링 SPA를 모두 다뤄야 하고, 탐색 요청에도 SSRF 방어가 동일하게 적용되어야 한다.

## 결정
1. **브라우저 DOM 기반 링크 탐색을 단일 기본 방식**으로 쓴다. 렌더링 후 `a[href]`의 절대 URL을 DOM 순서대로 수집한다.
2. 탐색은 **BFS**로 하고, 발견 순서(depth, 부모 URL, 페이지 내 링크 순서)를 manifest에 기록한다. 최종 PDF 순서는 이 순서를 기본으로 하되 설정의 수동 순서로 덮어쓸 수 있다.
3. `sitemap.xml`은 **보조 정보**(누락 후보 보고)로만 쓰고 탐색 범위를 넓히는 데 쓰지 않는다.
4. URL 정규화: fragment 제거 → 추적 파라미터(`utm_*`, `gclid`, `fbclid` 등) 제거 → **쿼리는 기본 제거(drop)**, 설정의 허용 파라미터 목록만 유지.
5. 범위 판정은 origin → path prefix(세그먼트 경계) → deny 패턴 → 다운로드 확장자 순서로 한다. **리다이렉트 후 최종 URL도 다시 판정**한다.
6. 멈춤 조건: `maxPages`, `maxDepth`, `maxTotalMs`, 페이지 타임아웃, `minDelayMs`, 동시성 1.

## 근거 (PoC 결과)
| 측정 | HTTP 응답 파싱 | 브라우저 DOM |
|---|---|---|
| 정적 fixture(6p) 발견 | 6p, 317ms | 6p, 10.7s |
| SPA fixture(4라우트) 발견 | **1p (링크 0)** | 4p |
| 범위 밖 링크 7종 제외 | 동일 | 동일 |

- HTTP 파싱은 빠르지만 SPA에서 실패한다. Node 쪽에 **별도의 네트워크 경로**를 만들게 되어, SSRF 방어(DNS 고정·리다이렉트 검증)를 두 번 구현해야 한다.
- 정책상 요청 간격이 `minDelayMs = 1000ms` 수준이므로, 브라우저 방식의 페이지당 약 1.1초는 병목이 아니다.
- 쿼리 유지(keep) 시 `list.html?page=N` 연쇄가 `maxDepth`에서야 멈췄다(T-07). 기본값은 drop이 안전하다.
- sitemap에는 실제 6페이지 중 3페이지만 있었다. 사이트 정보가 불완전할 수 있다.

## 한계·후속
- 범용 렌더링 대기(load → networkidle → DOM 변경 정지 500ms)는 "로딩 중..." 상태로 멈춘 SPA 라우트도 **안정 상태로 오판**했다. 사이트별 `readySelector`/`contentSelector` 설정과 실패 판정 규칙이 필요하다(보고서 D-08, D-14).
- 메뉴 DOM 순서를 장 순서로 쓰는 사이트별 Adapter는 MVP 범위 밖(05-architecture §5)이다.
