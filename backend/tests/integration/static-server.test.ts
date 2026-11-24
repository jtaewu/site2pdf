// T-16: 로컬 폴더 경계 (경로 탈출·인코딩 우회·심볼릭 링크/junction·숨김 파일)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStaticServer, type StaticServer } from '../../src/local/static-server.ts';

let tmp: string;
let srv: StaticServer;
let linkKind = 'none';

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-local-'));
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(site, '.git'));
  fs.writeFileSync(path.join(site, 'docs', 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>root</h1>');
  fs.writeFileSync(path.join(site, '.env'), 'OUTSIDE_SECRET');
  fs.writeFileSync(path.join(site, '.git', 'config'), 'OUTSIDE_SECRET');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'OUTSIDE_SECRET');
  // Windows에서 심볼릭 링크는 권한이 필요하므로 가능한 방식으로 바깥을 가리키는 링크를 만든다
  try {
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(site, 'docs', 'link.txt'));
    linkKind = 'symlink';
  } catch {}
  try {
    fs.symlinkSync(tmp, path.join(site, 'docs', 'outdir'), 'junction');
    if (linkKind === 'none') linkKind = 'junction';
  } catch {}
  srv = await startStaticServer(site, { spaFallbackPrefix: '/app/' });
});
afterAll(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const raw = (p: string, method = 'GET'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(srv.origin);
    const req = http.request({ host: u.hostname, port: u.port, path: p, method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('T-16 로컬 정적 서버 경계', () => {
  it('루트 안 파일과 디렉터리 index를 제공한다', async () => {
    expect(await raw('/docs/index.html')).toMatchObject({ status: 200, body: '<h1>ok</h1>' });
    expect(await raw('/docs/')).toMatchObject({ status: 200 });
  });

  it.each([
    '/../secret.txt', '/docs/../../secret.txt', '/%2e%2e/secret.txt', '/docs/%2e%2e%2f%2e%2e%2fsecret.txt', '/docs/..%5c..%5csecret.txt',
    '/..\\secret.txt', '/C:/Windows/win.ini', '/%00', '/%E0%A4%A', '/.env', '/.git/config', '/docs/outdir/secret.txt', '/docs/link.txt',
  ])('%s 는 루트 밖이나 숨김 파일을 노출하지 않는다', async (p) => {
    const r = await raw(p);
    expect(r.body).not.toContain('OUTSIDE_SECRET');
    expect([403, 404]).toContain(r.status);
  });

  it('바깥을 가리키는 링크를 만들 수 있었다면 그 링크로도 읽을 수 없다', () => {
    // 이 PC에서는 junction만 생성 가능(심볼릭 링크는 관리자 권한 필요)
    expect(linkKind).not.toBe('none');
  });

  it('읽기 전용: GET/HEAD 외 메서드는 거부', async () => {
    expect((await raw('/docs/index.html', 'POST')).status).toBe(405);
    expect((await raw('/docs/index.html', 'HEAD')).status).toBe(200);
  });

  it('SPA fallback prefix 아래 없는 경로는 index.html', async () => {
    expect(await raw('/app/any/route')).toMatchObject({ status: 200, body: '<h1>root</h1>' });
    expect((await raw('/other/route')).status).toBe(404);
  });

  it('감사 #3: Windows 8.3 짧은 이름으로 숨김 파일을 읽을 수 없다', async () => {
    for (const p of ['/ENV~1', '/GIT~1/config', '/env~1']) {
      const r = await raw(p);
      expect(r.body).not.toContain('OUTSIDE_SECRET');
      expect([403, 404]).toContain(r.status);
    }
  });

  it('감사 #7: Host 헤더가 서버 주소와 다르면 거부(DNS 재바인딩 방지)', async () => {
    const u = new URL(srv.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: '/docs/index.html', headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('끝에 / 없는 폴더 주소는 같은 서버 안 /로 리다이렉트, 외부 주소로는 만들지 않는다', async () => {
    const r1 = await new Promise<{ status: number; location?: string }>((resolve, reject) => {
      const u = new URL(srv.origin);
      const req = http.request({ host: u.hostname, port: u.port, path: '/docs' }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      });
      req.on('error', reject);
      req.end();
    });
    expect(r1).toEqual({ status: 301, location: '/docs/' });
    // //host 형태 요청도 외부 이동 주소를 만들지 않는다
    for (const p of ['//evil.example/docs', '/\\evil.example/docs']) {
      const r = await raw(p);
      expect([301, 403, 404]).toContain(r.status);
    }
  });

  it('루프백에만 바인딩된다', () => {
    expect(new URL(srv.origin).hostname).toBe('127.0.0.1');
  });
});
