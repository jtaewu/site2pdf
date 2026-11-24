// Phase 3: 민감정보 탐지(FR-15), 마스킹 보강(T-20, 감사 #2), IPv6 보강(감사 #4·#5), 출력 경로 보호(T-18)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { scanSensitive } from '../../src/report/sensitive.ts';
import { maskText, maskUrl } from '../../src/report/mask.ts';
import { nonPublicIpReason } from '../../src/fetch-policy/ip.ts';
import { assertSafeOutputDir, safeJoin } from '../../src/config/load.ts';
import { configSchema } from '../../src/config/schema.ts';
import { Site2pdfError } from '../../src/errors.ts';
import { main } from '../../src/cli/index.ts';

describe('FR-15 민감정보 탐지 (값은 가림)', () => {
  it.each([
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'bearer-token'],
    ['key = AKIAIOSFODNN7EXAMPLE', 'aws-access-key'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'private-key'],
    ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'github-token'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt'],
    ['api_key: "sk_live_0123456789abcdef"', 'secret-assignment'],
  ])('%s → %s', (text, type) => {
    const hits = scanSensitive(`설명 문장 ${text} 끝`);
    expect(hits.map((h) => h.type)).toContain(type);
    for (const h of hits) expect(h.sample.endsWith('***')).toBe(true);
    // 표본에 원문 비밀값 전체가 들어가지 않는다
    expect(hits.some((h) => h.sample.length > 9)).toBe(false);
  });

  it('일반 문서 문장은 탐지하지 않는다', () => {
    expect(scanSensitive('API 키는 관리자 콘솔에서 발급합니다. password 항목은 8자 이상이어야 합니다. Bearer 방식 설명.')).toEqual([]);
  });
});

describe('T-20 로그 마스킹 보강 (감사 #2)', () => {
  it.each([
    ['HTTPS://user:S3cret@docs.example.com/', 'S3cret'],
    ['ftp://u:Pw0rd@files.example.com/x', 'Pw0rd'],
    ['https://a.example.com/cb#access_token=tok123456&state=1', 'tok123456'],
    ['https://u:pa)ss@bad host/', 'pa)ss'],
  ])('%s 에서 %s 를 가린다', (url, secret) => {
    expect(maskText(`거부: ${url} 입니다`)).not.toContain(secret);
  });

  it('정상 URL은 그대로 둔다', () => {
    expect(maskUrl('https://docs.example.com/a?page=2#intro')).toBe('https://docs.example.com/a?page=2#intro');
  });

  it('CLI 오류 출력에 URL 비밀번호가 남지 않는다', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      chunks.push(String(c));
      return true;
    });
    try {
      expect(await main(['discover', '--url', 'HTTPS://admin:TopS3cret@docs.example.com/'])).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('userinfo-not-allowed');
    expect(out).not.toContain('TopS3cret');
  });
});

describe('IPv6 보강 (감사 #4·#5)', () => {
  it.each([
    ['::7f00:1', 'IPv4-compatible 루프백'],
    ['::a9fe:a9fe', 'IPv4-compatible 메타데이터'],
    ['::ffff:0:a00:1', 'SIIT 사설'],
    ['fe80::1%eth0', '존 ID'],
  ])('%s (%s) 는 비공개로 차단', (ip) => {
    expect(nonPublicIpReason(ip)).not.toBeNull();
  });
  it('공개 IPv6는 통과', () => {
    expect(nonPublicIpReason('2606:4700:4700::1111')).toBeNull();
  });
});

describe('T-18 출력 경로 보호', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-outdir-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  const local = configSchema.parse({ mode: 'local', sourcePath: site });
  const code = (fn: () => void) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return e instanceof Site2pdfError ? `${e.exitCode}:${e.code}` : 'unexpected';
    }
  };

  it.each([
    [path.join(site, 'out'), '2:output-inside-source'],
    [site, '2:output-inside-source'],
    [path.join(site, 'docs', 'new', 'deep'), '2:output-inside-source'],
    [path.join(tmp, 'out'), 'ok'],
  ])('%s → %s', (out, expected) => {
    expect(code(() => assertSafeOutputDir(local, out))).toBe(expected);
  });

  it('출력 경로가 파일이면 거부', () => {
    const f = path.join(tmp, 'file.txt');
    fs.writeFileSync(f, 'x');
    expect(code(() => assertSafeOutputDir(local, f))).toBe('2:output-not-directory');
  });

  it.each(['../escape.pdf', 'pdf/../../escape.pdf', path.resolve(tmp, 'abs.pdf')])('safeJoin(%s) 는 출력 폴더 밖이면 보안 오류', (rel) => {
    expect(code(() => safeJoin(path.join(tmp, 'out'), rel))).toBe('4:output-path-escape');
  });

  it('safeJoin 정상 경로', () => {
    expect(safeJoin(path.join(tmp, 'out'), 'pdf/pages/001-a.pdf')).toBe(path.join(tmp, 'out', 'pdf', 'pages', '001-a.pdf'));
  });
});
