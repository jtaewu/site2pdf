import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.ts';
import { loadRobots } from '../../src/discover/robots.ts';
import { maskText, maskUrl } from '../../src/report/mask.ts';
import { Site2pdfError } from '../../src/errors.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-cfg-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (name: string, data: unknown) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, JSON.stringify(data));
  return f;
};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof Site2pdfError ? `${e.exitCode}:${e.code}` : `unexpected:${(e as Error).message}`;
  }
};

describe('설정 검증', () => {
  it('--url 만으로 기본값이 채워진다 (D-03, D-06)', () => {
    const { config, configHash } = loadConfig({ url: 'https://docs.example.com/guide' });
    expect(config.mode).toBe('remote');
    expect(config.scope.allowedOrigins).toEqual(['https://docs.example.com']);
    expect(config.crawl).toMatchObject({ maxPages: 200, maxDepth: 5, minDelayMs: 1000, timeoutMs: 15000, concurrency: 1, respectRobotsTxt: true, query: { policy: 'drop' } });
    expect(configHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('로컬 설정의 sourcePath는 설정 파일 기준 상대 경로로 해석', () => {
    fs.mkdirSync(path.join(tmp, 'site'), { recursive: true });
    const f = write('local.json', { mode: 'local', sourcePath: './site' });
    expect(loadConfig({ configPath: f }).config).toMatchObject({ mode: 'local', sourcePath: path.join(tmp, 'site'), startPath: '/' });
  });

  it.each([
    ['--url와 --source 동시 지정', () => loadConfig({ url: 'https://a.example.com/', source: tmp }), '2:input-conflict'],
    ['입력 없음', () => loadConfig({}), '2:input-missing'],
    ['http URL', () => loadConfig({ url: 'http://a.example.com/' }), '2:start-url-rejected'],
    ['사설 IP URL', () => loadConfig({ url: 'https://192.168.0.10/' }), '2:start-url-rejected'],
    ['없는 로컬 폴더', () => loadConfig({ source: path.join(tmp, 'nope') }), '2:source-not-found'],
    ['알 수 없는 필드', () => loadConfig({ configPath: write('x1.json', { mode: 'remote', startUrl: 'https://a.example.com/', crawl: { turbo: true } }) }), '2:config-invalid'],
    ['동시성 2', () => loadConfig({ configPath: write('x2.json', { mode: 'remote', startUrl: 'https://a.example.com/', crawl: { concurrency: 2 } }) }), '2:config-invalid'],
    ['다른 origin 추가', () => loadConfig({ configPath: write('x3.json', { mode: 'remote', startUrl: 'https://a.example.com/', scope: { allowedOrigins: ['https://b.example.com'] } }) }), '2:origin-not-allowed'],
    ['원격 요청 간격 과소', () => loadConfig({ configPath: write('x4.json', { mode: 'remote', startUrl: 'https://a.example.com/', crawl: { minDelayMs: 100 } }) }), '2:delay-too-short'],
    ['비공개 리소스 origin', () => loadConfig({ configPath: write('x5.json', { mode: 'remote', startUrl: 'https://a.example.com/', resources: { allowedOrigins: ['https://10.0.0.1'] } }) }), '2:resource-origin-rejected'],
    ['로컬 모드 origin 지정', () => loadConfig({ configPath: write('x6.json', { mode: 'local', sourcePath: '.', scope: { allowedOrigins: ['http://x'] } }) }), '2:origin-not-allowed'],
  ])('%s → 거부', (_name, fn, expected) => {
    expect(codeOf(fn)).toBe(expected);
  });

  it('CLI --source 는 설정 파일의 원격 입력을 대체하고 원격 전용 필드를 버린다', () => {
    const f = write('remote.json', { mode: 'remote', startUrl: 'https://a.example.com/', resources: { allowedOrigins: [] }, crawl: { maxPages: 7 } });
    const { config } = loadConfig({ configPath: f, source: tmp });
    expect(config).toMatchObject({ mode: 'local', sourcePath: tmp, crawl: { maxPages: 7 } });
    expect('resources' in config).toBe(false);
  });
});

describe('T-08 robots.txt 정책', () => {
  const origin = 'https://a.example.com';
  it('404는 robots 없음(허용)', async () => {
    expect((await loadRobots(origin, async () => ({ status: 404, body: '' }))).state).toBe('absent');
  });
  it.each([
    [{ status: 403, body: '' }, 'http-403'],
    [{ status: 500, body: '' }, 'http-500'],
    [{ error: 'net::ERR_TIMED_OUT' }, 'net::ERR_TIMED_OUT'],
  ])('확인 실패 %j → unavailable(수집 중지)', async (res, reason) => {
    expect(await loadRobots(origin, async () => res)).toEqual({ state: 'unavailable', reason });
  });
  it('Disallow와 site2pdf 전용 규칙, Crawl-delay를 해석', async () => {
    const body = 'User-agent: *\nDisallow: /private/\n\nUser-agent: site2pdf\nDisallow: /docs/draft/\nCrawl-delay: 2\n';
    const r = await loadRobots(origin, async () => ({ status: 200, body }));
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    expect(r.isAllowed(`${origin}/docs/a`)).toBe(true);
    expect(r.isAllowed(`${origin}/docs/draft/x`)).toBe(false);
    expect(r.crawlDelaySec).toBe(2);
  });
});

describe('T-20 로그 마스킹', () => {
  it('URL userinfo와 민감 쿼리 값을 가린다', () => {
    expect(maskUrl('https://u:p@a.com/x?token=abc&page=2&api_key=zz')).toBe('https://***@a.com/x?token=***&page=2&api_key=***');
  });
  it('문장 속 URL과 Bearer 토큰을 가린다', () => {
    expect(maskText('fail https://a.com/?session=SECRET1 with Authorization: Bearer abcdefghijkl')).toBe('fail https://a.com/?session=*** with Authorization: Bearer ***');
  });
});
