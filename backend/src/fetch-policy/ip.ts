import net from 'node:net';

// 공개 인터넷 주소가 아닌 범위(루프백·사설·링크로컬·CGNAT·문서용·멀티캐스트·예약 등)
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKED: Array<[string, number]> = [
  // ::/96 IPv4-compatible(예 ::7f00:1), ::ffff:0:0:0/96 SIIT (보안 감사 #4)
  ['::', 96], ['::ffff:0:0:0', 96], ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

const blockList = new net.BlockList();
for (const [addr, prefix] of V4_BLOCKED) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of V6_BLOCKED) blockList.addSubnet(addr, prefix, 'ipv6');

/** `[::1]` 같은 대괄호 표기를 벗긴다 */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** IPv4-mapped IPv6(::ffff:a.b.c.d, ::ffff:7f00:1)이면 내장 IPv4를 돌려준다 */
function embeddedV4(ip: string): string | null {
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(canonical);
  if (dotted?.[1]) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return null;
}

/**
 * 공개 주소가 아니면 차단 사유를, 공개 주소면 null을 돌려준다.
 * IP 문자열이 아니면 'not-an-ip'.
 */
export function nonPublicIpReason(ip: string): string | null {
  const addr = stripBrackets(ip);
  const family = net.isIP(addr);
  if (family === 0) return 'not-an-ip';
  if (family === 6) {
    // 존 ID(fe80::1%eth0)는 링크로컬 전용 표기 → 비공개로 본다. 해석 불가 표기도 안전하게 차단 (보안 감사 #5)
    if (addr.includes('%')) return 'zone-id-address';
    let v4: string | null;
    try {
      v4 = embeddedV4(addr);
    } catch {
      return 'unparsable-ipv6';
    }
    if (v4) return nonPublicIpReason(v4) ? 'ipv4-mapped-non-public' : null;
    return blockList.check(addr, 'ipv6') ? 'non-public-address' : null;
  }
  return blockList.check(addr, 'ipv4') ? 'non-public-address' : null;
}
