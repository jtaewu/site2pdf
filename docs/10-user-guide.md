# 10. 사용·운영 가이드

> 대상: site2pdf로 문서 사이트를 PDF로 만드는 개발자·운영 담당자·문서 담당자
> 버전 0.1 / 2026-11-24 (Phase 3 기준)

## 1. 시작 전 확인 (필수)
- [ ] 변환할 사이트의 **소유자이거나 수집·복제 허락**을 받았다. 접근할 수 있다고 해서 재배포 권한이 있는 것은 아니다.
- [ ] 로그인·차단을 우회해야 하는 사이트가 아니다(우회 기능은 없다).
- [ ] 가능하면 원격 URL보다 **담당자에게 받은 정적 빌드 폴더(`--source`)**를 쓴다. 외부 요청이 없고 결과가 재현된다.
- [ ] 결과 PDF를 외부에 배포할 계획이면 저작권·민감정보 검수자를 정했다.

## 2. 설치
Node.js 24 이상, Git이 필요하다.
```bash
git clone https://github.com/jtaewu/site2pdf.git
cd site2pdf/backend && npm install && npm run browser:install && cd ..
```
아래 예시는 Windows(`site2pdf.cmd`) 기준이다. macOS·Linux·Git Bash는 `./site2pdf`를 쓴다.

## 3. 작업 순서
```bash
# 1) 진단: 접근 가능 여부, robots, 링크 수, 본문 영역 설정 후보
site2pdf.cmd audit --source D:/site-build -o out

# 2) 설정 파일 작성 (config/examples 복사 후 수정) → site.json
#    audit가 알려 준 render.contentSelector / readySelector 를 넣는다

# 3) 탐색 → out/discovered.json 검수 (빠진 페이지, 제외 사유, 실패 페이지)
site2pdf.cmd discover -c site.json -o out

# 4) PDF 생성 (검수한 목록 그대로)
site2pdf.cmd generate -c site.json -o out --discovered out/discovered.json

# 5) 결과 검증 → out/validation.json
site2pdf.cmd validate --manifest out/manifest.json

# 6) out/report.md 체크리스트로 육안 검수
```
`discover` 이후 설정을 바꾸면 `--discovered`가 거부된다(설정 해시 불일치). 설정을 고쳤다면 `discover`부터 다시 한다.

## 4. 설정 요약
전체 항목과 기본값은 `docs/04-functional-spec.md` §3을 본다.

| 하고 싶은 것 | 설정 |
|---|---|
| 특정 경로만 변환 | `scope.pathPrefixes: ["/docs"]` |
| 관리자·로그아웃 등 제외 | `scope.denyPatterns: ["/admin", "/logout"]` |
| 탐색은 하되 PDF에서 빼기 | `selection.exclude: ["/docs/old/**"]` |
| 통합 PDF 앞쪽 순서 지정 | `selection.order: ["/docs/intro.html", ...]` |
| 메뉴·헤더 없이 본문만 | `render.contentSelector: "main"` (audit 추천값) |
| SPA 렌더 완료 신호 | `render.readySelector: "main h1"` |
| 특정 요소 숨기기 | `render.hideSelectors: [".cookie-banner"]` |
| 영역별 PDF 추가 | `pdf.groups: [{ "name": "API", "pathPrefixes": ["/docs/api"] }]` |
| 통합 PDF 제목·파일명 | `pdf.title`, `pdf.fileName` |
| 외부 CDN 글꼴·이미지 허용(원격) | `resources.allowedOrigins: ["https://cdn.example.com"]` — 보안 검토 후에만 |
| 느린 사이트 | `crawl.timeoutMs`(기본 15000), `crawl.retries`(기본 1) |

## 5. 보안 운영 지침
- **기본 보호(코드에 내장)**: 브라우저의 모든 요청은 로컬 이그레스 프록시를 거치며 내부망·클라우드 메타데이터 주소, 리다이렉트·DNS 재바인딩, WebRTC(UDP), 서비스워커, 팝업, 다운로드를 막는다. 로컬 모드는 지정 폴더 밖 파일을 읽지 않고 외부 요청을 하지 않는다.
- **권장 추가 격리(실행 환경)**: 원격 사이트를 정기적으로 변환한다면 컨테이너나 전용 계정에서 실행하고, 방화벽으로 **대상 사이트 HTTPS(443) 외 외부 연결을 막는다**(ADR-004 L-D). 코드의 방어가 알려지지 않은 경로로 뚫려도 피해를 줄인다.
- **시스템 브라우저(`--browser-channel`)는 개발용**이다. 조직 정책·확장 프로그램이 결과와 보안에 영향을 줄 수 있다. 프록시를 거치지 않는 것이 감지되면 자동으로 중지한다.
- **결과물 취급**: `out/` 폴더에는 문서 원문이 들어 있다. 사내 전용 문서라면 공유 위치와 보관 기간을 정한다. `report.md`의 "민감정보로 보이는 문자열"은 반드시 확인한다(자동 탐지는 일부만 잡는다).
- **로그**: 콘솔 로그는 URL 비밀번호·토큰 파라미터·Bearer 값을 가린다. 단, `discovered.json`·`manifest.json`에는 탐색한 URL이 그대로 남는다(쿼리 파라미터는 기본으로 제거).
- **출력 폴더**는 원본 사이트 폴더 밖이어야 한다(안이면 거부).

## 6. 지원하지 않는 것 (MVP 한계)
| 항목 | 현재 동작 |
|---|---|
| 로그인·인증이 필요한 페이지, 캡차 | 지원 안 함. 401/403/429면 중지. 정상 응답으로 오는 캡차 화면은 자동 판별 못 함 |
| 다른 출처 iframe(유튜브 등), 외부 CDN 리소스 | 기본 차단 → 빈 프레임·깨진 이미지, 경고 표시 |
| 동영상·오디오·캔버스 | 첫 화면 그대로 인쇄, 경고 표시 |
| 탭·아코디언 안 숨은 내용 | 화면에 보이는 상태대로 인쇄(펼치지 않음) |
| 한 쪽보다 긴 iframe | 쪽 경계에서 나뉘지 않아 밀리거나 잘릴 수 있음 |
| 통합·그룹 PDF의 접근성 태그 | 없음(페이지별 PDF에는 있음). 텍스트 검색·북마크는 됨 |
| 링크 순서와 다른 메뉴 순서 | 발견(BFS) 순서가 기본. `selection.order`로 지정 |
| Markdown/MDX 원본 직접 변환, DOCX/EPUB, GUI, 예약 실행 | MVP 범위 밖 |
| 실제 외부 사이트 검증 | 승인된 테스트 URL이 없어 루프백 HTTPS 환경으로만 검증함 |

## 7. 오류·경고 FAQ
| 증상 | 원인과 조치 |
|---|---|
| 종료 코드 2 + `robots.txt ...` | 사이트가 수집을 금지했거나 robots를 확인할 수 없음. 우회하지 말고 담당자에게 확인 |
| 종료 코드 2 + `접근 거부(401/403/...)` | 권한이 없거나 차단됨. 승인된 경로·로컬 빌드를 요청 |
| 종료 코드 2 + `discovered-config-mismatch` | discover 이후 설정이 바뀜. discover부터 다시 |
| 종료 코드 2 + `output-inside-source` | 출력 폴더를 원본 폴더 밖으로 지정 |
| 종료 코드 3 + 일부 페이지 실패 | `report.md`의 실패 사유 확인. `render-timeout`은 다시 실행하거나 `crawl.timeoutMs` 증가 |
| `content-too-short`, `ready-selector-not-found` | 렌더가 안 끝났거나 선택자가 틀림. `audit` 추천값 확인 |
| 종료 코드 4 | 내부 주소로 이동, 프록시 우회 감지, 결과 파일 손상·경로 이탈(validate). 결과를 배포하지 말 것 |
| `horizontal-overflow`, `text-coverage` 경고 | 오른쪽이 잘렸을 수 있음. 해당 페이지 육안 확인, 필요하면 `contentSelector` 지정 |
| `blocked-requests` 경고 | 범위 밖 이미지·글꼴이 차단됨. 필요하면 보안 검토 후 `resources.allowedOrigins` |
| `sensitive-content` 경고 | 토큰·키 형태 문자열. 실제 비밀값이면 원본 문서를 고친 뒤 다시 생성 |
| 브라우저 실행 실패 | `cd backend && npm run browser:install` |

## 8. 첫 적용(KICC 등) 절차 — Phase 4
1. 문서 담당자에게 **정적 빌드 폴더**와 **배포 승인 범위**를 받는다(운영 사이트 접근이 막혀 있어도 진행 가능).
2. `audit --source <빌드>`로 본문 영역 후보와 링크 수를 확인한다.
3. 사이트 전용 설정을 `config/examples/<사이트>.json`으로 만든다. 엔진 코드는 고치지 않는다.
4. discover → 목록 검수 → generate → validate → `report.md` 육안 검수 → 담당자 승인 후 배포.

## 9. 내부망(인터넷 없는 PC)으로 옮기기
반입 용량 제한(예: 200MB)이 있어도 되도록, 실행에 필요한 것만 모아 압축하고 190MB 조각으로 나눈다. 시험 결과 **전체 약 160MB, 1개 파일**이다(브라우저는 헤드리스용만, 라이브러리는 실행용만 포함).

**인터넷 PC에서** (저장소를 받고 `cd backend; npm.cmd ci; npm.cmd run browser:install` 를 끝낸 상태)
```powershell
cd C:\site2pdf
.\make-offline-bundle.cmd            # 결과: C:\site2pdf-offline
```
`C:\site2pdf-offline`의 `site2pdf-offline.pack.001`(…002…), `restore.cmd`, `restore.mjs`, `안내.txt`와 Node.js 24 설치 파일(.msi)을 옮긴다.
압축·복원은 Node.js 내장 기능만 쓰므로 Windows 버전이나 명령 창 한글 설정(코드 페이지)과 무관하다. 복원 전에 조각마다 SHA-256으로 손상 여부를 확인한다. 반입 제한이 더 작으면 `$env:S2P_PART_MB="90"; .\make-offline-bundle.cmd`처럼 조각 크기를 줄인다.

**내부망 PC에서**
1. Node.js 설치
2. 옮긴 파일을 한 폴더에 모으고 `restore.cmd` 더블클릭 → `C:\site2pdf`에 설치, 브라우저 경로 설정, 샘플 변환까지 자동 확인
3. 새 PowerShell 창에서 `cd C:\site2pdf` → `.\site2pdf.cmd generate --source C:\sample-site -o C:\result`

다른 위치에 설치하려면 명령 프롬프트에서 `restore.cmd D:\tools\site2pdf`처럼 경로를 넘긴다. PowerShell에서 `npm`이 실행 정책 오류를 내면 `npm.cmd`를 쓴다.
