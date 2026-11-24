# 06. 기술 설계

## 1. URL 정규화 및 탐색
- 절대 URL 기준으로 상대 URL 해석, fragment 제거, 불필요한 추적 쿼리 파라미터 처리 정책 기록.
- 동일 URL 중복 제거. 쿼리 URL은 무한 조합 위험 때문에 허용 목록 또는 제한 규칙 적용.
- 동일 origin, path prefix, include/deny 패턴 순서로 검사. 리다이렉트 후 URL도 재검증.
- `<a href>` 링크 탐색을 기본으로 하며 sitemap.xml·내비게이션 순서는 Phase 0 PoC에서 선택; 링크 순서가 실제 문서 순서와 같다고 단정하지 않음.
- `maxPages`, `maxDepth`, `maxTotalMs`, 페이지 타임아웃, 최소 요청 간격, 동시성 제한을 모두 적용.
- robots.txt 확인 실패·금지 시 기본 행동은 해당 원격 대상 수집 중지(예외는 승인 후 별도 결정).

## 2. SSRF 및 네트워크 방어
- 원격 모드: HTTPS만 허용, URL에 포함된 사용자 정보 거부, 허용 origin 외 차단.
- DNS 조회 전/후 및 리다이렉트마다 비공개 주소 검사; 연결 시 실제 목적지 검증이 필요한 문제를 테스트. 단순 DNS 사전조회만으로 충분하다고 가정하지 않음.
- IPv4/IPv6 loopback·사설·링크로컬·멀티캐스트·예약 IP와 메타데이터 주소 차단.
- 브라우저 request interception만으로 서비스 워커·직접 소켓 등의 위험을 완전히 막는다고 가정하지 않음; 가능하면 **OS/컨테이너 egress 제한**을 함께 적용.
- 자바스크립트가 외부 목적지로 이동/호출하거나 새 페이지를 여는 경우 제한/차단.
- 로컬 모드는 명시적 로컬 서버만 접근 가능하도록 원격 모드와 별도 네트워크 정책으로 실행.

## 3. PDF 렌더링
- `print` 미디어를 기반으로 렌더링하되, 문서가 숨겨진 인쇄 CSS를 갖는 경우 별도 옵션을 평가.
- DOM 준비, 이미지 완료, 글꼴 준비를 유한 시간 내 기다린 뒤 출력.
- 목차용 제목 추출은 `title`, `h1`, nav 텍스트 순으로 규칙 정의하되 중복 시 보고.
- `@page` A4 기본, 사용자 변경 옵션 제공. `pre` 줄바꿈, 넓은 표, 고정 헤더/사이드바 제거를 우선 검증.
- 페이지별 PDF 병합 시 북마크와 내부 링크가 끊길 수 있으므로 PoC에서 검증 후 Should로 구현.
- 영상/캔버스/iframe 등 인쇄 불가 콘텐츠는 미지원/경고로 표기. 모든 동적 사이트의 완벽한 복제를 약속하지 않음.

```css
@page { size: A4; margin: 14mm; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
img, svg { max-width: 100%; height: auto; }
h1, h2, h3 { break-after: avoid; }
```

## 4. 산출물
```text
output/
  discovered.json
  manifest.json
  report.md
  pdf/pages/001-title.pdf
  pdf/site-combined.pdf
  pdf/groups/             # Should
```
파일명은 URL만으로 결정하지 않고 인덱스+정제된 제목+충돌 방지 규칙을 사용한다.

## 5. 실패 처리
- URL별 `discovered/skipped/succeeded/failed`를 기록.
- PDF 누락·리소스 실패는 보고서에 표시. 필수 문서 실패 시 종료 코드 비정상.
- 안전 정책 위반은 재시도하지 않으며, 일시적인 정상 페이지 실패만 횟수 제한 후 재시도.
- 원본 사이트에 대한 과도한 요청과 스크린샷/본문 로그 저장을 기본적으로 피한다.

## 6. PoC 우선 확인
1. 정적 문서 사이트 vs JS SPA 탐색/출력
2. 텍스트·한글/코드/표 보존
3. 병합 후 북마크/하이퍼링크 가능 여부
4. 외부 리소스 차단 시 스타일/이미지 손실
5. 실제 연결 목적지 검증과 서비스워커 차단 가능 여부
