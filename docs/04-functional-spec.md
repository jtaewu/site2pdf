# 04. 기능 및 CLI 명세

| 버전 | 날짜 | 변경 |
|---|---|---|
| 0.1 | 2026-11-24 | 초안 |
| 0.2 | 2026-11-24 | Phase 1 구현에 맞춰 구조·CLI·설정·discovered.json·종료 코드 확정 (D-03, D-06, D-08, D-09, D-11, D-14 반영) |
| 0.3 | 2026-11-24 | Phase 2: `generate`, `--discovered`, `pdf.*`·`selection.order` 설정, manifest.json·report.md, PDF 링크·북마크 규칙 (D-07, D-10, D-15 반영) |
| 0.4 | 2026-11-24 | 일시적 실패 재시도(`crawl.retries`), audit 렌더 설정 후보, iframe 펼침 경고, 실행기(`site2pdf.cmd`) |

## 1. 구조
```text
site2pdf/
  backend/                 # 변환 엔진 + CLI
    src/
      cli/                 # 인자 해석, 종료 코드 (bin.ts 진입점)
      config/              # 설정 스키마(zod)·로딩·검증
      fetch-policy/        # URL 정규화·범위 판정, IP 판정, 이그레스 프록시
      local/               # 로컬 모드 정적 서버
      browser/             # Chromium 실행, 안전 컨텍스트, 페이지 로더(실패 판정)
      discover/            # BFS 탐색, robots, 선택(include/exclude)
      audit/               # 사전 진단
      render/              # 인쇄 준비(범용 CSS·본문 영역·표·넘침 탐지·앵커 프로브), 페이지 1개 PDF
      pdf/                 # 링크 재작성·북마크·병합(pdf-lib), 텍스트 추출(pdfjs), 파일명
      generate/            # 변환 대상 확정, generate 명령
      report/              # 출력 JSON, report.md, 로그 마스킹
      session.ts           # 모드별 실행 구성
    tests/{unit,integration,e2e}/
  frontend/                # 예약 (GUI는 MVP 범위 밖)
  config/examples/
  fixtures/
  docs/  prompts/  poc/
  output/                  # gitignore
```

## 2. CLI
```bash
# backend/ 에서
npm run cli -- audit    --url https://example.com/docs [--config ./site.json] [--output ./output]
npm run cli -- discover --url https://example.com/docs [--config ./site.json] [--output ./output]
npm run cli -- discover --source ./dist-site [--config ./local.json] [--output ./output]
npm run cli -- generate --source ./dist-site [--config ./local.json] [--output ./output] [--discovered ./output/discovered.json]
# Phase 3 예정
site2pdf validate --manifest ./output/manifest.json
```
- 권장 흐름: `discover` → `discovered.json` 검수(필요하면 `selection` 설정 수정 후 다시 discover) → `generate --discovered`.
- `--discovered`: 검수한 목록으로 변환한다. 설정 해시(`configHash`)와 모드가 같아야 하며, 목록의 각 경로는 현재 범위로 다시 검증한다(목록 파일을 고쳐 범위를 넓힐 수 없음). 없으면 `generate`가 탐색부터 다시 하고 `discovered.json`도 쓴다.
- `--url`: 원격 HTTPS. 소유 또는 명시적 수집 권한이 있는 사이트만. userinfo가 들어간 URL은 거부.
- `--source`: 로컬 빌드 폴더. `--url`과 함께 쓸 수 없다. CLI 입력이 있으면 설정 파일의 입력 필드를 대체한다.
- `--config`/`-c`: 설정 JSON. 상대 경로(`sourcePath`)는 설정 파일 위치 기준.
- `--output`/`-o`: 결과 폴더(기본 `./output`). `audit.json`, `discovered.json`을 쓴다.
- `--browser-channel chrome|msedge`: 개발 편의용 시스템 브라우저. 기본은 Playwright 전용 Chromium (ADR-001).
- `--verbose`/`-v`: 상세 로그. 로그의 URL 민감 파라미터·userinfo·Bearer 값은 마스킹한다.

## 3. 설정 파일
알 수 없는 필드는 오류로 처리한다. 괄호 안은 기본값.

```json
{
  "mode": "remote",
  "startUrl": "https://example.com/docs/",
  "scope": {
    "allowedOrigins": [],                 // (자동: 시작 URL origin) 다른 origin 지정 시 오류
    "pathPrefixes": ["/docs"],            // (["/"]) 세그먼트 경계로 비교
    "denyPatterns": ["/admin", "/logout", "?download="]  // 경로+쿼리 부분 문자열
  },
  "crawl": {
    "maxPages": 200, "maxDepth": 5, "minDelayMs": 1000, "timeoutMs": 15000, "maxTotalMs": 600000,
    "concurrency": 1,                     // 1 고정
    "respectRobotsTxt": true,
    "retries": 1,                         // 일시적 실패(시간 초과·502/503/504·연결 끊김)만 재시도. 보안 차단·4xx는 재시도 안 함
    "query": { "policy": "drop", "keepParams": [] }   // drop: keepParams 외 쿼리 제거
  },
  "resources": { "allowedOrigins": [] },  // (원격 전용) 하위 리소스만 추가 허용할 https origin. 보안 검토 후 지정
  "render": {
    "readySelector": "main h1",           // (없음) 나타나야 렌더 완료
    "contentSelector": "main",            // (없음) 본문 영역. 없으면 실패
    "hideSelectors": [],                  // Phase 2 인쇄에서 사용
    "minTextLength": 20,                  // 본문 글자 수 미만이면 실패
    "quietMs": 500                        // DOM 변경 정지 시간
  },
  "selection": {
    "include": ["/docs/**"], "exclude": ["/docs/private/**"],   // 경로 glob(picomatch)
    "order": ["/docs/intro.html"]         // ([]) 통합 PDF 앞쪽에 둘 경로 순서. 나머지는 발견 순서
  },
  "pdf": {
    "pageSize": "A4",                     // A4 | A3 | Letter | Legal
    "marginMm": 14,
    "printBackground": true,
    "pagewise": true,                     // 페이지별 PDF (FR-06)
    "combined": true,                     // 통합 PDF (FR-07)
    "title": "제품 개발자 문서",           // (시작 페이지 제목) 통합 PDF 제목 메타데이터 (FR-13)
    "fileName": "site-combined",          // 통합 PDF 파일명(확장자 제외, 정제됨)
    "groups": []                          // 그룹별 PDF(FR-11)는 Phase 3. 현재 빈 배열만 허용
  }
}
```
- 원격 모드: `crawl.minDelayMs`는 500ms 이상이어야 한다.
- 로컬 모드: `mode: "local"`, `sourcePath`(필수), `startPath`(`/`), `spaFallbackPrefix`(SPA History 라우팅 빌드용, 이 prefix 아래 없는 경로는 `index.html`). `scope.allowedOrigins`·`resources`는 지정하지 않는다(로컬 서버만 허용, 외부 네트워크 없음).
- 예시: `config/examples/`.

## 4. 탐색 규칙 요약
- 브라우저 DOM에서 `a[href]`를 문서 순서대로 수집하고 BFS로 방문한다(ADR-002).
- 정규화: fragment 제거, 추적 파라미터(`utm_*`, `gclid`, `fbclid` 등) 제거, 쿼리 정책 적용, 파라미터 정렬, 호스트 끝 점 제거.
- 범위 판정 순서: 스킴 → origin → path prefix → deny 패턴 → 다운로드 확장자. 리다이렉트 후 최종 URL도 다시 판정한다.
- robots.txt(원격): 404/410은 허용, 그 외 확인 실패나 시작 URL 금지는 수집 중지. 금지 URL은 요청하지 않는다. `Crawl-delay`가 `minDelayMs`보다 길면 따른다. User-agent 토큰은 `site2pdf`.
- 401/403/407/429 응답은 우회하지 않고 전체 탐색을 멈춘다.
- 페이지 실패 판정(D-14): 응답 없음, HTTP 4xx/5xx, 이그레스 차단, 최종 URL 범위 밖, 렌더 시간 초과, 에러 페이지로 이동, `readySelector`/`contentSelector` 미발견, 본문 `minTextLength` 미만.
- 선택(include/exclude)은 탐색 범위를 바꾸지 않고 각 페이지의 `selected`와 사유만 정한다.

## 5. 출력 파일
### discovered.json
- 메타: `schemaVersion`, `command`, `tool{name,version}`, `runId`, `createdAt`, `finishedAt`, `exitCode`, `message`, `mode`, `input`, `configHash`, `config`(검증된 전체 설정), `robots`
- `result`: `stopReason`(`exhausted`·`max-pages`·`max-total-time`·`access-denied`·`start-failed`), `notVisited`, `requests`, `effectiveDelayMs`, `elapsedMs`, `counts`
- `pages[]`: `order`, `url`, `path`, `depth`, `foundOn`, `status`(ok|failed), `httpStatus`, `finalUrl`, `redirectChain`, `title`, `textLength`, `failure`, `selected`, `selectionReason`, `elapsedMs`
- `excluded[]`: `url`, `reason`, `foundOn` (범위 밖·deny·robots·깊이 초과·중복·미방문 등)
- `blockedRequests[]`: 브라우저 계층에서 막은 요청 요약(유형·origin·건수·예시)
- `egressDenied[]`: 이그레스 프록시가 거부한 목적지 요약
### audit.json
시작 페이지 상태·리다이렉트·제목, 링크 통계(범위 안 수, 제외 사유별 수), `renderSuggestion`(본문 영역 `contentSelector`·`readySelector` 후보: 첫 h1을 담은 HTML 의미 요소 우선, 없으면 본문 텍스트 50% 이상을 담는 가장 작은 영역), sitemap(보조), 차단 내역, `findings`(사람이 읽는 진단 문장). 요청은 robots.txt·시작 페이지·sitemap.xml 각 1회.
### manifest.json (generate)
- 메타: discovered.json과 같은 항목 + `discoveredFrom`(파일 경로 또는 `inline-discover`)
- `summary`: `planned`, `rendered`, `failed`, `skipped`, `warnings`
- `combined`: `file`, `pages`, `outlineEntries`, `links`(`gotos` 내부 이동, `anchorExact` 앵커 위치까지 정확, `removed`, `kept` 외부 유지, `brokenNamed`)
- `pages[]`: `order`, `url`, `path`, `title`, `titleSource`(h1|title|path), `status`(rendered|failed), `failure`, `pdfFile`, `pdfPages`, `combinedStartPage`, `warnings`, `qa`(`coverage`, `overflow`, `tightTables`, `missingSamples`), `blocked`, `elapsedMs`
- `skipped[]`: 변환 대상에서 빠진 경로와 사유(discover 실패, 선택 제외, 범위 밖, 중복, robots)
- 경고: `unsupported-content:<태그>x<수>`(다른 출처·차단 iframe, video, canvas 등), `iframe-expanded:<수>`(같은 사이트 iframe을 내용 높이만큼 펼쳐 인쇄), `horizontal-overflow:<태그>`, `text-coverage:<비율>`(0.99 미만), `blocked-requests:<수>`, `duplicate-title`, `retried:<수>`
### report.md
사람이 읽는 요약(결과·페이지 표·제외·차단·경고 의미)과 육안 검수 체크리스트(07 §3).
### PDF 파일
- `pdf/pages/NNN-<정제된 제목>.pdf`: 페이지별 PDF. 이전 실행의 `NNN-*.pdf`는 지운다.
- `pdf/<fileName>.pdf`: 통합 PDF. 장 = 페이지, 북마크는 장 아래 해당 페이지의 제목(h2…) 계층.
- 장 제목: 본문 첫 `h1` → 문서 `title` → 경로 순. 같은 제목이 여러 번이면 `duplicate-title` 경고.
- 링크(D-10): 포함 페이지로 가는 링크는 통합 PDF 안 이동(앵커가 있으면 그 위치), 제외·범위 밖 같은 사이트 링크는 링크만 제거(텍스트 유지), 다른 사이트 링크는 유지. 페이지별 PDF에서 포함 페이지 링크는 원격이면 웹 주소로 유지, 로컬이면 제거(루프백 주소 노출 방지).

## 6. 종료 코드
| 코드 | 의미 | 예 |
|---|---|---|
| `0` | 모든 필수 단계 성공 | 한도(maxPages 등) 도달은 성공이되 `message`·`stopReason`에 표시 |
| `2` | 입력·설정·권한 확인 실패 | 잘못된 URL·설정, robots 금지·확인 실패, 401/403/429, `--discovered` 설정 불일치 |
| `3` | 탐색·렌더링·변환 실패 | 일부 페이지 실패(통합 PDF는 성공 페이지만으로 만들되 실패로 표시), 시작 페이지 실패, 변환 대상 0개, 브라우저 실행 실패 |
| `4` | 보안 정책 위반 | 시작 호스트가 비공개 주소로 해석, 시작 페이지가 범위 밖이나 이그레스 차단 목적지(내부 IP 등)로 리다이렉트 |
