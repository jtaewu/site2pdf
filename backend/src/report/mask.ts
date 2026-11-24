// 로그·콘솔 출력용 비밀값 마스킹 (T-20). 원본 데이터 파일에는 적용하지 않는다.
const SENSITIVE_PARAM = /(token|key|secret|passw|pwd|auth|session|sig|signature|credential|code|ticket|jwt)/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    for (const key of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(key)) u.searchParams.set(key, '***');
    return u.href;
  } catch {
    return raw;
  }
}

/** 문자열 안의 URL과 Authorization 헤더 형태 값을 마스킹 */
export function maskText(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, (m) => maskUrl(m)).replace(BEARER, '$1 ***');
}
