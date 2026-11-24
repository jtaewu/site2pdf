// 로그·콘솔 출력용 비밀값 마스킹 (T-20). 원본 데이터 파일에는 적용하지 않는다.
const SENSITIVE_PARAM = /(token|key|secret|passw|pwd|auth|session|sig|signature|credential|code|ticket|jwt)/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// 스킴 무관·대소문자 무관 URL (보안 감사 #2: HTTPS://, ftp:// 등)
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function maskParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SENSITIVE_PARAM.test(key)) {
      params.set(key, '***');
      changed = true;
    }
  }
  return changed;
}

export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    maskParams(u.searchParams);
    // fragment 안의 토큰(#access_token=...)도 가린다
    if (u.hash.includes('=')) {
      const h = new URLSearchParams(u.hash.slice(1));
      if (maskParams(h)) u.hash = h.toString();
    }
    return u.href;
  } catch {
    // 파싱 실패 시 사용자 정보 구간(//…@)을 통째로 가린다
    return raw.replace(/\/\/[^/?#\s]*@/, '//***@');
  }
}

/** 문자열 안의 URL과 Authorization 헤더 형태 값을 마스킹 */
export function maskText(text: string): string {
  return text.replace(ANY_URL, (m) => maskUrl(m)).replace(BEARER, '$1 ***');
}
