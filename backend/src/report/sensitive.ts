// FR-15 민감정보 경고 (D-12): PDF 내용은 바꾸지 않고, 토큰·키 형태 문자열을 찾아 종류와 가린 표본만 보고한다.
// 오탐·미탐이 있을 수 있으므로 외부 배포 전 사람의 검수를 대신하지 않는다.
const PATTERNS: Array<[type: string, re: RegExp]> = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer-token', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ['secret-assignment', /\b(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{12,}/gi],
];

export type SensitiveHit = { type: string; count: number; sample: string };

/** 값은 앞 6자만 남기고 가린다 */
const mask = (s: string) => `${s.slice(0, 6)}***`;

export function scanSensitive(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const [type, re] of PATTERNS) {
    const found = text.match(re);
    if (found?.length) hits.push({ type, count: found.length, sample: mask(found[0]) });
  }
  return hits;
}
