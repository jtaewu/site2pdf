// URL·IP 정책 PoC. Phase 1에서 테스트와 함께 다시 구현할 것(이 파일을 그대로 쓰지 않음).
import net from 'node:net';

const v4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const v6 = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];
const blocked = new net.BlockList();
for (const [a, p] of v4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of v6) blocked.addSubnet(a, p, 'ipv6');

/** 비공개/예약 주소면 차단 사유 문자열, 공개 주소면 null */
export function blockedIpReason(ip) {
  const fam = net.isIP(ip);
  if (!fam) return 'not-an-ip';
  // IPv4-mapped IPv6(::ffff:a.b.c.d 또는 ::ffff:7f00:1)는 내장된 v4로 다시 판정
  if (fam === 6) {
    const mapped = new URL(`http://[${ip}]/`).hostname; // 표기 정규화
    const dotted = /^\[::ffff:(\d+\.\d+\.\d+\.\d+)\]$/i.exec(mapped);
    const hex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(mapped);
    if (dotted) return blockedIpReason(dotted[1]) ? 'ipv4-mapped-private' : null;
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16 >>> 0) + parseInt(hex[2], 16);
      const v = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return blockedIpReason(v) ? 'ipv4-mapped-private' : null;
    }
  }
  return blocked.check(ip, fam === 4 ? 'ipv4' : 'ipv6') ? 'private-or-reserved' : null;
}

/** 원격 모드 입력 URL 정적 검증 (DNS 이전 단계) */
export function validateRemoteUrl(raw, { allowedPorts = ['', '443'] } = {}) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid-url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'scheme-not-https', url: u.href };
  if (u.username || u.password) return { ok: false, reason: 'userinfo-not-allowed' };
  if (!allowedPorts.includes(u.port)) return { ok: false, reason: 'port-not-allowed', url: u.href };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { const r = blockedIpReason(host); if (r) return { ok: false, reason: 'ip-' + r, url: u.href }; }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)$/i.test(host)) return { ok: false, reason: 'local-hostname', url: u.href };
  return { ok: true, url: u.href };
}

const TRACKING = /^(utm_\w+|gclid|fbclid|mc_cid|mc_eid)$/i;
/** fragment 제거, 추적 파라미터 제거, 쿼리 정책(keep|drop) 적용 */
export function normalizeUrl(raw, base, { query = 'keep' } = {}) {
  let u;
  try { u = new URL(raw, base); } catch { return null; }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  if (query === 'drop') u.search = '';
  else u.searchParams.sort();
  return u.href;
}

/** origin·path prefix(세그먼트 경계)·deny 패턴 순서로 범위 판정. 제외 시 사유, 포함 시 null */
export function scopeCheck(href, scope) {
  let u;
  try { u = new URL(href); } catch { return 'invalid-url'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'scheme:' + u.protocol;
  if (!scope.allowedOrigins.includes(u.origin)) return 'origin-out-of-scope';
  const okPrefix = scope.pathPrefixes.some(p => u.pathname === p || u.pathname.startsWith(p.endsWith('/') ? p : p + '/'));
  if (!okPrefix) return 'path-out-of-scope';
  const target = u.pathname + u.search;
  const hit = (scope.denyPatterns || []).find(d => target.includes(d));
  if (hit) return 'deny:' + hit;
  if (/\.(zip|exe|msi|dmg|pdf|tar|gz|7z)$/i.test(u.pathname)) return 'download-extension';
  return null;
}
