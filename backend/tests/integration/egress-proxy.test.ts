// T-03/T-04/T-05: 이그레스 프록시 정책 (가짜 DNS, 루프백 소켓만 사용)
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startEgressProxy, type EgressProxy } from '../../src/fetch-policy/egress-proxy.ts';

let target: http.Server;
let tPort = 0;
let hits: string[] = [];

beforeAll(async () => {
  target = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.end('target');
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  tPort = (target.address() as net.AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => target.close(() => r())));

/** 프록시에 절대 URL로 HTTP 요청 */
function viaProxy(proxy: EgressProxy, url: string): Promise<{ status: number; blocked?: string }> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, blocked: res.headers['x-site2pdf-blocked'] as string | undefined }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 프록시에 CONNECT 요청 (HTTPS/WSS 경로) */
function connect(proxy: EgressProxy, hostPort: string): Promise<number> {
  const p = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function withProxy(opts: Parameters<typeof startEgressProxy>[0], fn: (p: EgressProxy) => Promise<void>) {
  hits = [];
  const proxy = await startEgressProxy(opts);
  try {
    await fn(proxy);
  } finally {
    await proxy.close();
  }
}

describe('이그레스 프록시', () => {
  it('허용 목록의 host:port 이고 예외 지정된 로컬 서버는 통과한다', async () => {
    await withProxy({ allowedHostPorts: [`docs.test:${tPort}`], privateExceptions: [`docs.test:${tPort}`], resolve: async () => ['127.0.0.1'] }, async (p) => {
      expect((await viaProxy(p, `http://docs.test:${tPort}/ok`)).status).toBe(200);
      expect(hits).toEqual(['GET /ok']);
    });
  });

  it('허용 목록 밖 호스트는 DNS 조회 없이 거부한다', async () => {
    let lookups = 0;
    await withProxy({ allowedHostPorts: ['docs.test:443'], resolve: async () => (lookups++, ['93.184.216.34']) }, async (p) => {
      expect(await viaProxy(p, `http://other.test:${tPort}/`)).toEqual({ status: 403, blocked: 'host-not-allowed' });
      expect(await connect(p, 'other.test:443')).toBe(403);
      expect(lookups).toBe(0);
    });
  });

  it('T-03 허용 호스트라도 비공개 주소(루프백·메타데이터·사설)로 해석되면 거부한다', async () => {
    for (const addr of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '::1', '::ffff:192.168.0.1']) {
      await withProxy({ allowedHostPorts: [`docs.test:${tPort}`], resolve: async () => [addr] }, async (p) => {
        expect(await viaProxy(p, `http://docs.test:${tPort}/`)).toMatchObject({ status: 403 });
        expect(hits).toEqual([]);
      });
    }
  });

  it('T-04 IP 리터럴로 직접 가는 요청(리다이렉트 후속 hop 포함)을 거부한다', async () => {
    await withProxy({ allowedHostPorts: [`docs.test:${tPort}`], privateExceptions: [`docs.test:${tPort}`], resolve: async () => ['127.0.0.1'] }, async (p) => {
      expect(await viaProxy(p, `http://127.0.0.1:${tPort}/via-302`)).toEqual({ status: 403, blocked: 'host-not-allowed' });
      expect(await viaProxy(p, `http://169.254.169.254/latest/meta-data`)).toEqual({ status: 403, blocked: 'host-not-allowed' });
      expect(hits).toEqual([]);
    });
  });

  it('T-05 DNS 재바인딩: 응답 주소 중 하나라도 비공개면 거부하고, 검사한 주소로만 연결한다', async () => {
    // 여러 주소를 섞어 돌려주는 재바인딩
    await withProxy({ allowedHostPorts: ['rebind.test:443'], resolve: async () => ['93.184.216.34', '127.0.0.1'] }, async (p) => {
      expect(await connect(p, 'rebind.test:443')).toBe(403);
      expect(p.decisions.at(-1)).toMatchObject({ allowed: false, reason: 'non-public-address', address: '127.0.0.1' });
    });
    // 조회할 때마다 답이 바뀌는 재바인딩: 앱의 사전 검사(1회차)는 공개 IP, 프록시 연결 시점(2회차)은 루프백
    let n = 0;
    const flipping = async () => (n++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
    const preCheck = await flipping();
    expect(preCheck).toEqual(['93.184.216.34']);
    await withProxy({ allowedHostPorts: [`rebind.test:${tPort}`], resolve: flipping }, async (p) => {
      expect(await viaProxy(p, `http://rebind.test:${tPort}/`)).toMatchObject({ status: 403, blocked: 'non-public-address' });
      expect(hits).toEqual([]);
    });
  });

  it('허용되지 않은 포트로의 CONNECT를 거부한다', async () => {
    await withProxy({ allowedHostPorts: ['docs.test:443'], resolve: async () => ['93.184.216.34'] }, async (p) => {
      expect(await connect(p, 'docs.test:22')).toBe(403);
      expect(await connect(p, 'docs.test:8443')).toBe(403);
    });
  });

  it('DNS 실패는 거부로 처리한다', async () => {
    await withProxy({ allowedHostPorts: [`docs.test:${tPort}`], resolve: async () => { throw new Error('ENOTFOUND'); } }, async (p) => {
      expect(await viaProxy(p, `http://docs.test:${tPort}/`)).toEqual({ status: 403, blocked: 'dns-failure' });
    });
  });
});
