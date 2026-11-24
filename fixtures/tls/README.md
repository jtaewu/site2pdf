# 테스트 전용 TLS 인증서

`docs.test`(실존하지 않는 테스트용 호스트) 자체 서명 인증서입니다. **원격(HTTPS) 모드 E2E 테스트에서만** 루프백 HTTPS fixture 서버에 쓰입니다.

- 실제 서비스나 다른 용도로 쓰지 마세요. 개인 키가 공개되어 있으므로 보안 가치가 없습니다.
- 테스트는 가짜 DNS로 `docs.test`를 127.0.0.1에 연결하고, 테스트 전용 옵션으로만 이 인증서를 신뢰합니다. CLI·설정 파일로는 이 옵션을 켤 수 없습니다.
- 재생성: `openssl req -x509 -newkey rsa:2048 -nodes -keyout docs.test.key -out docs.test.crt -days 3650 -subj "/CN=docs.test" -addext "subjectAltName=DNS:docs.test"`
