# 05. 아키텍처

## 1. 전체 흐름
```mermaid
flowchart TD
  A[승인된 URL 또는 로컬 빌드] --> B[입력·권한·범위 검사]
  B --> C[URL/링크 탐색 및 정규화]
  C --> D[대상 페이지 선택·순서 확정]
  D --> E[격리된 브라우저 렌더링]
  E --> F[페이지별 PDF 출력]
  F --> G[통합/그룹 PDF 생성]
  G --> H[manifest·검증 보고서]
  H --> I{검증 통과?}
  I -->|예| J[사용자 검수 후 배포]
  I -->|아니오| K[실패 목록/수정]
```

## 2. 주요 모듈
- **Input/Audit**: URL/로컬 입력과 접근·복제 승인, 구조·의존성 확인.
- **Fetch Policy**: SSRF 보호, DNS/리다이렉트/리소스 요청 검증, origin·path·robots·rate 제한. 브라우저 트래픽 전체를 받는 **이그레스 프록시**(해석→IP 검사→그 IP로 연결)를 포함한다 (ADR-004).
- **Discover**: 링크 수집, URL 정규화, 순환·중복 방지, 깊이와 페이지 수 제한.
- **Select**: 발견 목록에 include/exclude/수동 순서를 적용.
- **Render**: Playwright 프린트 렌더링, 대기 조건, 화면 UI 제외, 자산 실패 보고.
- **PDF**: 페이지별 출력, 병합, 목차/북마크 PoC 및 링크 정책.
- **Report**: manifest, 진단·검증 보고서, 실패 종료 코드.

## 3. 신뢰 경계
1. **입력**: URL·HTML·JS·리다이렉트 모두 비신뢰. CLI는 허용 사이트만 수집.
2. **네트워크**: 원격은 HTTPS/승인 origin·경로만 허용. 호스트 이름만 검사해서 끝내지 말고 DNS와 실제 연결 주소를 방어; 브라우저의 모든 하위 요청·리다이렉트도 검사. loopback/사설/링크로컬/예약 범위·클라우드 메타데이터 차단.
3. **로컬**: `--source` 파일 경로는 선택한 루트 밖을 참조하지 않도록 경로 정규화/심볼릭 링크 방지. 로컬 서버는 루프백 바인딩, 원격 네트워크 사용 금지.
4. **리소스**: 외부 CDN/iframe/다운로드는 기본 거부하고, 필요한 경우 명시적 예외는 보안 검토. 렌더링 콘텐츠는 임의 명령 실행에 접근하지 못하게 격리.
5. **출력**: 경로 탈출 방지, HTML로부터 만든 파일명 정제, 사용자 원본 데이터·시크릿 로그 마스킹. 생성 파일은 자동 대외 배포하지 않음.

## 4. 기술 선택 (Phase 0 ADR 승인으로 확정)
- Node.js 24 + TypeScript(빌드 없이 Node type stripping으로 실행, `tsc --noEmit`으로 검사): CLI/URL 정책/데이터 흐름
- Playwright + **전용 Chromium**: 브라우저 탐색·PDF 렌더링 (ADR-001). 시스템 Chrome은 개발 옵션으로만
- 설정 검증 zod, glob picomatch, robots.txt robots-parser
- PDF 병합: pdf-lib (ADR-003, Phase 2)
- 테스트: vitest. 단위(네트워크 없음) + 통합(루프백 소켓) + 브라우저 E2E(로컬 fixture)
- 코드 위치: `backend/`. `frontend/`는 GUI용 예약 폴더(MVP 범위 밖)

## 5. 확장 포인트
특정 사이트 메뉴 분석을 위해 별도 Adapter 인터페이스를 추가할 수 있지만 **MVP는 표준 링크 탐색부터 구현**. KICC 특수 규칙을 코어에 넣지 않는다.
