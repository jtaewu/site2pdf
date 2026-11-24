# 04. 기능 및 CLI 명세

## 1. 구조 (목표)
```text
site2pdf/
  src/
    cli/
    audit/
    discover/
    fetch-policy/
    render/
    pdf/
    report/
  config/examples/
  fixtures/
  tests/
  docs/
  prompts/
  output/          # gitignore
```

## 2. CLI 초안 (미구현)
```bash
site2pdf audit --url https://example.com/docs --config ./config/site.json
site2pdf discover --url https://example.com/docs --config ./config/site.json --output ./output
site2pdf generate --url https://example.com/docs --config ./config/site.json --output ./output
site2pdf generate --source ./dist-site --config ./config/local.json --output ./output
site2pdf validate --manifest ./output/manifest.json
```
- `--url`: 원격 HTTPS. 접근 및 복제 권한 확인 필수. **임의 자격증명 URL 금지**.
- `--source`: 로컬 빌드 디렉터리. 입력 모드는 상호 배타적.
- `discover`: 목록 및 제외 이유를 출력; `generate`는 목록을 검증·확정한 이후 실행할 수 있도록 설계.
- 실제 CLI 라이브러리/명령명은 Phase 1에서 테스트로 고정.

## 3. 설정 파일 초안
```json
{
  "mode": "remote",
  "startUrl": "https://example.com/docs",
  "scope": {
    "allowedOrigins": ["https://example.com"],
    "pathPrefixes": ["/docs"],
    "denyPatterns": ["/admin", "/logout", "?download="]
  },
  "crawl": {
    "maxPages": 50,
    "maxDepth": 3,
    "minDelayMs": 1000,
    "timeoutMs": 15000,
    "maxTotalMs": 300000,
    "concurrency": 1,
    "respectRobotsTxt": true
  },
  "selection": {"include": ["/docs/**"], "exclude": ["/docs/private/**"]},
  "pdf": {"pageSize": "A4", "pagewise": true, "combined": true, "groups": []}
}
```
`allowedOrigins`는 시작 URL의 origin과 일치하도록 제한하며, 추가 origin은 MVP에서 승인 검토 없이 자동 추가하지 않는다. `include/exclude`의 구체적 패턴 문법은 Phase 1에서 확정한다.

## 4. 로컬 설정 예시
```json
{
  "mode": "local",
  "sourcePath": "./fixtures/site",
  "scope": {"pathPrefixes": ["/"]},
  "crawl": {"maxPages": 50, "maxDepth": 3},
  "pdf": {"pageSize": "A4", "pagewise": true, "combined": true}
}
```
로컬 모드에서도 HTML 내부의 원격 스크립트·이미지 요청은 기본 차단한다.

## 5. manifest.json 필드(초안)
- 실행 ID, 시작/입력 경로, 모드, 설정 해시, 생성 일시, 프로그램 버전
- 발견 URL, 정규화 URL, 제목, 깊이, 발견 경로, 선택/제외 여부·사유
- 렌더링 상태, 에러 유형, 원본→출력 페이지 대응, 생성 PDF 경로
- 실패 리소스/경고 목록, 검증 상태

## 6. 실패/종료 코드
- `0`: 모든 필수 단계 성공
- `2`: 입력/설정/권한 확인 실패
- `3`: 탐색·렌더링·변환 실패
- `4`: 보안 정책 위반 또는 출력 검증 실패
숫자는 CLI 계약 고정 전에 테스트로 확정한다.
