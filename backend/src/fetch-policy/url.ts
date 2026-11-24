import net from 'node:net';
import { nonPublicIpReason, stripBrackets } from './ip.ts';

export type QueryPolicy = { policy: 'drop' | 'keep'; keepParams: string[] };

export type Scope = {
  /** 정규화된 origin 목록 (예: https://docs.example.com) */
  allowedOrigins: string[];
  /** 세그먼트 경계로 비교하는 경로 prefix (예: /docs) */
  pathPrefixes: string[];
  /** 경로+쿼리에 포함되면 제외하는 문자열 */
  denyPatterns: string[];
};

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|yclid)$/i;
const DOWNLOAD_EXT = /\.(zip|exe|msi|dmg|pkg|deb|rpm|apk|iso|tar|gz|tgz|bz2|xz|7z|rar|pdf|docx?|xlsx?|pptx?)$/i;
const LOCAL_HOSTNAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

/** 호스트 끝의 점(FQDN 표기)을 제거한 URL. 같은 사이트가 두 origin으로 갈라지는 것을 막는다 */
function stripTrailingDot(u: URL): void {
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
}

/** origin 문자열 정규화 (스킴·호스트 소문자, 기본 포트 제거, 끝 점 제거) */
export function normalizeOrigin(raw: string): string {
  const u = new URL(raw);
  stripTrailingDot(u);
  return u.origin;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string; url?: string };

/**
 * 원격 모드 입력 URL 정적 검증 (DNS 조회 전 단계).
 * https만, userinfo 금지, 허용 포트만, IP 리터럴은 공개 주소만, 내부용 호스트명 금지.
 */
export function validateRemoteUrl(raw: string, allowedPorts: string[] = ['', '443']): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'scheme-not-https', url: u.href };
  if (u.username || u.password) return { ok: false, reason: 'userinfo-not-allowed' };
  if (!allowedPorts.includes(u.port)) return { ok: false, reason: 'port-not-allowed', url: u.href };
  stripTrailingDot(u);
  const host = stripBrackets(u.hostname);
  if (net.isIP(host)) {
    const reason = nonPublicIpReason(host);
    if (reason) return { ok: false, reason: `ip-${reason}`, url: u.href };
  } else if (LOCAL_HOSTNAME.test(host) || !host.includes('.')) {
    return { ok: false, reason: 'local-hostname', url: u.href };
  }
  return { ok: true, url: u.href };
}

/**
 * 링크 URL 정규화: 상대 경로 해석, fragment 제거, 추적 파라미터 제거, 쿼리 정책 적용, 파라미터 정렬.
 * 해석 불가하면 null.
 */
export function normalizeUrl(raw: string, base: string, query: QueryPolicy): string | null {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  stripTrailingDot(u);
  u.hash = '';
  const keep = new Set(query.keepParams);
  for (const key of [...new Set(u.searchParams.keys())]) {
    if (TRACKING_PARAM.test(key) || (query.policy === 'drop' && !keep.has(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  if ([...u.searchParams.keys()].length === 0) u.search = '';
  return u.href;
}

/** prefix를 세그먼트 경계로 비교 (/docs 는 /docs, /docs/x 와 일치하고 /docs-old 와는 불일치) */
export function matchesPathPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/' || prefix === '') return true;
  const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === p || pathname.startsWith(`${p}/`);
}

/**
 * 탐색 범위 판정. 범위 안이면 null, 밖이면 제외 사유.
 * 순서: 스킴 → origin → path prefix → deny 패턴 → 다운로드 확장자
 */
export function scopeExclusionReason(href: string, scope: Scope): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return 'invalid-url';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `scheme:${u.protocol.replace(':', '')}`;
  stripTrailingDot(u);
  if (!scope.allowedOrigins.includes(u.origin)) return 'origin-out-of-scope';
  if (!scope.pathPrefixes.some((p) => matchesPathPrefix(u.pathname, p))) return 'path-out-of-scope';
  const target = u.pathname + u.search;
  const deny = scope.denyPatterns.find((d) => target.includes(d));
  if (deny) return `deny:${deny}`;
  if (DOWNLOAD_EXT.test(u.pathname)) return 'download-extension';
  return null;
}
