# 설정 예시

| 파일 | 용도 |
|---|---|
| `remote.json` | 원격 HTTPS 사이트 (소유 또는 명시적 수집 권한이 있는 사이트만). `startUrl`은 예시 주소입니다 |
| `local-static.json` | 로컬 정적 빌드 (`fixtures/static-site`) |
| `local-spa.json` | 로컬 SPA 빌드 (`fixtures/spa-site`, History 라우팅) |

- 상대 경로(`sourcePath`)는 설정 파일 위치 기준으로 해석됩니다.
- 사이트별 특수 설정(`render.readySelector`, `render.contentSelector` 등)은 이 폴더에 예시로만 두고, 엔진 코드에 하드코딩하지 않습니다.
- 모든 필드와 기본값은 `docs/04-functional-spec.md` §3을 참고하세요.
