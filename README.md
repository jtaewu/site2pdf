# site2pdf

승인된 웹사이트 URL 또는 로컬 정적 사이트를 **안전하게 탐색**해 PDF로 내보내는 CLI입니다. 특정 문서 플랫폼에 종속되지 않습니다.

> 현재 단계: **Phase 3 완료 (MVP 기능 완성)** — `audit`, `discover`, `generate`, `validate` 명령을 쓸 수 있습니다. 남은 단계는 실제 사이트(KICC) 적용(Phase 4)입니다. 자세한 사용·운영 방법은 [docs/10-user-guide.md](docs/10-user-guide.md)를 보세요.

## 설치 (처음 한 번)

필요: **Node.js 24 이상**, Git

```bash
git clone https://github.com/jtaewu/site2pdf.git
cd site2pdf/backend
npm install
npm run browser:install          # 전용 Chromium 설치 (약 150MB)
cd ..
```

## 사용법

저장소 폴더에서 실행기를 씁니다. Windows는 `site2pdf.cmd`, macOS·Linux·Git Bash는 `./site2pdf`입니다. 경로는 실행하는 위치 기준입니다.

```bash
# 1) 진단: 시작 페이지·robots·링크 수·본문 영역 설정 후보(render.contentSelector)를 알려줌
site2pdf.cmd audit --source D:/문서사이트/build -o output

# 2) 탐색: 변환할 페이지 목록(output/discovered.json)을 만들고 검수
site2pdf.cmd discover --source D:/문서사이트/build -o output

# 3) PDF 생성: 검수한 목록으로 변환
site2pdf.cmd generate --source D:/문서사이트/build -o output --discovered output/discovered.json

# 4) 결과 검증: 파일 누락·손상·순서·경로 이탈·민감정보 (output/validation.json)
site2pdf.cmd validate --manifest output/manifest.json

# 원격 사이트 (소유 또는 명시적 수집 권한이 있는 HTTPS 사이트만)
site2pdf.cmd generate --url https://docs.example.com/docs/ -o output
```

사이트에 맞춘 설정(범위·제외 경로·본문 영역·PDF 제목 등)은 JSON 파일로 만들어 `-c 설정.json`으로 넘깁니다. 예시는 [config/examples/](config/examples/)에 있습니다. `audit`가 알려 준 `contentSelector`를 넣으면 메뉴·여백 없이 본문만 깔끔하게 인쇄됩니다.

결과:
- `output/pdf/<파일명>.pdf`: 통합 PDF (장별 북마크, 다른 페이지 링크는 PDF 안에서 해당 위치로 이동)
- `output/pdf/pages/NNN-제목.pdf`: 페이지별 PDF
- `output/pdf/groups/NN-이름.pdf`: 그룹별 PDF (설정 `pdf.groups`)
- `output/report.md`, `output/manifest.json`: 페이지별 결과·경고와 **육안 검수 체크리스트**
- `output/discovered.json`, `output/audit.json`: 탐색·진단 결과

종료 코드: `0` 성공, `2` 입력·설정·권한 문제(접근 거부·robots 금지 포함), `3` 탐색·변환 실패(일부 실패 포함), `4` 보안 정책 위반.

자동 검사는 잘림·누락의 일부만 잡습니다. 배포 전에 `report.md`의 체크리스트로 PDF를 직접 확인하세요.

### 문제 해결
- **`Node.js 24 이상이 필요합니다`**: https://nodejs.org 에서 LTS를 설치하세요.
- **브라우저 실행 실패**: `cd backend && npm run browser:install`. 회사 정책으로 다운로드가 막히면 설치된 Chrome을 쓸 수 있습니다: `--browser-channel chrome` (조직 정책·확장 프로그램이 결과에 영향을 줄 수 있어 권장하지 않음).
- **일부 페이지 `render-timeout`**: PC가 바쁘면 생길 수 있습니다. 일시적 실패는 자동으로 1회 재시도하며(`crawl.retries`), 그래도 실패하면 다시 실행하거나 `crawl.timeoutMs`를 늘리세요.
- **`content-too-short` / `ready-selector-not-found`**: 렌더링이 끝나지 않았거나 본문 영역 설정이 맞지 않습니다. `audit`의 설정 후보를 확인하세요.

## 안전 원칙

- 원격은 HTTPS·시작 URL과 같은 origin·지정 경로 안에서만, 요청 간격(기본 1초)과 페이지·깊이·시간 상한을 지켜 탐색합니다.
- 브라우저의 모든 요청은 로컬 이그레스 프록시를 거칩니다. 프록시는 비공개 주소(루프백·사설망·클라우드 메타데이터 등)로의 연결을 막아 리다이렉트·DNS 재바인딩을 통한 SSRF를 차단합니다.
- 401/403/429, robots.txt 금지·확인 실패를 만나면 우회하지 않고 멈춥니다.
- 실패한 페이지를 성공으로 표시하지 않습니다.

## 구성

```text
site2pdf.cmd, site2pdf  실행기
backend/                변환 엔진 + CLI (TypeScript, 개발은 backend/ 에서 npm test)
frontend/               예약 폴더 (GUI는 MVP 범위 밖)
config/examples/        설정 예시
fixtures/               테스트용 사이트 (tls/ 는 테스트 전용 인증서)
docs/                   요구사항·설계·ADR
poc/                    Phase 0 PoC (폐기용)
```

자세한 내용은 [docs/00-ai-dev-guide.md](docs/00-ai-dev-guide.md)부터 읽어 주세요.
