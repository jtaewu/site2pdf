# site2pdf

승인된 웹사이트 URL 또는 로컬 정적 사이트를 **안전하게 탐색**해 PDF로 내보내는 CLI입니다. 특정 문서 플랫폼에 종속되지 않습니다.

> 현재 단계: **Phase 1 (CLI·설정·안전한 탐색)** — `audit`, `discover` 명령까지 구현되어 있습니다. PDF 생성(`generate`)은 Phase 2 예정입니다.

## 빠른 시작

```bash
cd backend
npm install
npm run browser:install          # 전용 Chromium 설치 (최초 1회, 약 150MB)

# 로컬 정적 사이트 탐색 (외부 네트워크 사용 안 함)
npm run cli -- discover -c ../config/examples/local-static.json -o ../output

# 원격 사이트 진단 (소유 또는 명시적 수집 권한이 있는 HTTPS 사이트만)
npm run cli -- audit --url https://docs.example.com/docs/ -o ../output
```

결과는 `output/discovered.json`, `output/audit.json`에 저장됩니다. 종료 코드: `0` 성공, `2` 입력·설정·권한 문제(접근 거부·robots 금지 포함), `3` 탐색 실패(일부 실패 포함), `4` 보안 정책 위반.

## 안전 원칙

- 원격은 HTTPS·시작 URL과 같은 origin·지정 경로 안에서만, 요청 간격(기본 1초)과 페이지·깊이·시간 상한을 지켜 탐색합니다.
- 브라우저의 모든 요청은 로컬 이그레스 프록시를 거칩니다. 프록시는 비공개 주소(루프백·사설망·클라우드 메타데이터 등)로의 연결을 막아 리다이렉트·DNS 재바인딩을 통한 SSRF를 차단합니다.
- 401/403/429, robots.txt 금지·확인 실패를 만나면 우회하지 않고 멈춥니다.
- 실패한 페이지를 성공으로 표시하지 않습니다.

## 구성

```text
backend/            변환 엔진 + CLI (TypeScript)
frontend/           예약 폴더 (GUI는 MVP 범위 밖)
config/examples/    설정 예시
fixtures/           테스트용 사이트
docs/               요구사항·설계·ADR
poc/                Phase 0 PoC (폐기용)
```

자세한 내용은 [docs/00-ai-dev-guide.md](docs/00-ai-dev-guide.md)부터 읽어 주세요.
