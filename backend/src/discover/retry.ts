// 일시적 실패만 제한 횟수 재시도한다 (06-technical-design §5).
// 보안 정책 차단·접근 거부·4xx·콘텐츠 판정 실패는 재시도하지 않는다.
const TRANSIENT = [
  /^render-timeout$/,
  /^pdf-timeout$/,
  /^no-response$/,
  /^render-error:/,
  /^http-(502|503|504)$/,
  // 시간 초과·연결 끊김류 네트워크 오류 (프록시 거부로 생기는 터널 실패·클라이언트 차단은 제외)
  /^navigation-error: .*(Timeout|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED)/,
];

export function isTransientFailure(failure: string | undefined): boolean {
  return !!failure && TRANSIENT.some((re) => re.test(failure));
}
