import { describe, expect, it } from 'vitest';
import { nonPublicIpReason } from '../../src/fetch-policy/ip.ts';
import { normalizeOrigin, normalizeUrl, scopeExclusionReason, validateRemoteUrl } from '../../src/fetch-policy/url.ts';

describe('T-01 정상 HTTPS URL', () => {
  it.each(['https://docs.example.com/guide', 'https://docs.example.com:443/a?b=1', 'https://xn--80ak6aa92e.com/'])('%s 허용', (u) => {
    expect(validateRemoteUrl(u).ok).toBe(true);
  });
});

describe('T-02 잘못된 스킴·userinfo·위험 포트 거부', () => {
  it.each([
    ['http://docs.example.com/', 'scheme-not-https'],
    ['ftp://docs.example.com/', 'scheme-not-https'],
    ['file:///etc/passwd', 'scheme-not-https'],
    ['javascript:alert(1)', 'scheme-not-https'],
    ['https://user:pw@docs.example.com/', 'userinfo-not-allowed'],
    ['https://user@docs.example.com/', 'userinfo-not-allowed'],
    ['https://docs.example.com:8443/', 'port-not-allowed'],
    ['https://docs.example.com:22/', 'port-not-allowed'],
    ['not a url', 'invalid-url'],
  ])('%s → %s', (u, reason) => {
    const r = validateRemoteUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });
});

describe('T-03 비공개 목적지 차단', () => {
  it.each([
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f.1/', 'https://017700000001/', 'https://127.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://169.254.169.254/latest/meta-data/',
    'https://[fd00::1]/', 'https://[fe80::1]/', 'https://10.0.0.5/', 'https://172.16.3.4/', 'https://192.168.0.1/',
    'https://100.64.1.1/', 'https://0.0.0.0/', 'https://[::]/', 'https://[64:ff9b::a9fe:a9fe]/',
  ])('%s 거부(IP)', (u) => {
    const r = validateRemoteUrl(u);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^ip-/);
  });

  it.each(['https://localhost/', 'https://foo.localhost/', 'https://metadata.google.internal/', 'https://printer.local/', 'https://intranet/', 'https://router.home.arpa/'])(
    '%s 거부(내부 호스트명)',
    (u) => {
      const r = validateRemoteUrl(u);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('local-hostname');
    },
  );

  it.each([
    ['8.8.8.8', null], ['1.1.1.1', null], ['172.32.0.1', null], ['2001:4860:4860::8888', null], ['::ffff:8.8.8.8', null],
    ['127.0.0.1', 'non-public-address'], ['::ffff:10.0.0.1', 'ipv4-mapped-non-public'], ['224.0.0.1', 'non-public-address'],
    ['255.255.255.255', 'non-public-address'], ['198.18.0.1', 'non-public-address'], ['ff02::1', 'non-public-address'], ['example.com', 'not-an-ip'],
  ])('IP %s → %s', (ip, reason) => {
    expect(nonPublicIpReason(ip)).toBe(reason);
  });
});

describe('URL 정규화', () => {
  const drop = { policy: 'drop' as const, keepParams: [] };
  const keep = { policy: 'keep' as const, keepParams: [] };

  it('fragment·추적 파라미터 제거, 파라미터 정렬', () => {
    expect(normalizeUrl('https://a.com/docs/x?utm_source=1&b=2&a=1#frag', 'https://a.com/', keep)).toBe('https://a.com/docs/x?a=1&b=2');
  });
  it('drop 정책은 허용 파라미터만 남긴다', () => {
    expect(normalizeUrl('https://a.com/x?page=3&lang=ko', 'https://a.com/', drop)).toBe('https://a.com/x');
    expect(normalizeUrl('https://a.com/x?page=3&lang=ko', 'https://a.com/', { policy: 'drop', keepParams: ['lang'] })).toBe('https://a.com/x?lang=ko');
  });
  it('상대 경로·점 세그먼트·기본 포트·대소문자·끝 점 정규화', () => {
    expect(normalizeUrl('../api/./ref.html', 'https://A.COM:443/docs/guide/intro.html', drop)).toBe('https://a.com/docs/api/ref.html');
    expect(normalizeUrl('https://docs.example.com./x', 'https://x/', drop)).toBe('https://docs.example.com/x');
    expect(normalizeOrigin('https://Docs.Example.com.:443')).toBe('https://docs.example.com');
  });
  it('해석 불가 URL은 null', () => {
    expect(normalizeUrl('http://[bad', 'https://a.com/', drop)).toBeNull();
  });
});

describe('T-06 범위 판정', () => {
  const scope = { allowedOrigins: ['https://a.com'], pathPrefixes: ['/docs'], denyPatterns: ['/admin', '?download='] };
  it.each([
    ['https://a.com/docs', null],
    ['https://a.com/docs/guide/x.html', null],
    ['https://b.com/docs/x', 'origin-out-of-scope'],
    ['http://a.com/docs/x', 'origin-out-of-scope'],
    ['https://a.com:8443/docs/x', 'origin-out-of-scope'],
    ['https://a.com/docs-old/x', 'path-out-of-scope'],
    ['https://a.com/blog/x', 'path-out-of-scope'],
    ['https://a.com/docs/admin/users', 'deny:/admin'],
    ['https://a.com/docs/file?download=1', 'deny:?download='],
    ['https://a.com/docs/manual.zip', 'download-extension'],
    ['https://a.com/docs/guide.PDF', 'download-extension'],
    ['mailto:x@a.com', 'scheme:mailto'],
    ['https://a.com./docs/x', null],
  ])('%s → %s', (u, reason) => {
    expect(scopeExclusionReason(u, scope)).toBe(reason);
  });
});
