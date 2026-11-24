// 이그레스 정책 프록시 (ADR-004 L-C).
// 브라우저의 모든 요청은 이 프록시를 거친다. 프록시는 목적지 호스트를 "한 번" 해석하고,
// 해석된 모든 주소를 검사한 뒤, 검사한 그 주소로만 연결한다(DNS 재바인딩·리다이렉트 이탈 방지).
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { nonPublicIpReason, stripBrackets } from './ip.ts';

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const list = await dns.lookup(host, { all: true, verbatim: true });
  return list.map((a) => a.address);
};

export type EgressPolicy = {
  /** 연결을 허용할 `host:port` 목록 (호스트는 소문자, IPv6는 대괄호 없이) */
  allowedHostPorts: string[];
  /** 비공개 주소라도 허용할 `host:port` (로컬 모드의 루프백 정적 서버 전용) */
  privateExceptions?: string[];
  resolve?: Resolver;
  connectTimeoutMs?: number;
};

export type EgressDecision = {
  kind: 'http' | 'connect' | 'upgrade';
  target: string;
  allowed: boolean;
  reason?: string;
  address?: string;
};

export type EgressProxy = {
  url: string;
  decisions: EgressDecision[];
  close(): Promise<void>;
};

const key = (host: string, port: number) => `${stripBrackets(host).toLowerCase().replace(/\.+$/, '')}:${port}`;

export async function startEgressProxy(policy: EgressPolicy): Promise<EgressProxy> {
  const allowed = new Set(policy.allowedHostPorts.map((hp) => hp.toLowerCase()));
  const exceptions = new Set((policy.privateExceptions ?? []).map((hp) => hp.toLowerCase()));
  const resolve = policy.resolve ?? systemResolver;
  const timeout = policy.connectTimeoutMs ?? 15_000;
  const decisions: EgressDecision[] = [];

  async function decide(host: string, port: number): Promise<{ ok: true; address: string } | { ok: false; reason: string; address?: string }> {
    const hp = key(host, port);
    if (!allowed.has(hp)) return { ok: false, reason: 'host-not-allowed' };
    const bare = stripBrackets(host);
    let addresses: string[];
    try {
      addresses = net.isIP(bare) ? [bare] : await resolve(bare);
    } catch {
      return { ok: false, reason: 'dns-failure' };
    }
    if (addresses.length === 0) return { ok: false, reason: 'dns-empty' };
    // 하나라도 비공개 주소면 거부 (응답마다 다른 주소를 섞는 재바인딩 대비)
    if (!exceptions.has(hp)) {
      for (const a of addresses) {
        const reason = nonPublicIpReason(a);
        if (reason) return { ok: false, reason, address: a };
      }
    }
    return { ok: true, address: addresses[0]! };
  }

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    const d = await decide(target.hostname, port);
    decisions.push({ kind: 'http', target: `${target.host}${target.pathname}`, allowed: d.ok, reason: d.ok ? undefined : d.reason, address: d.address });
    if (!d.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'x-site2pdf-blocked': d.reason }).end('blocked by site2pdf egress policy');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const upstream = http.request(
      { host: d.address, port, method: req.method, path: target.pathname + target.search, headers, timeout, setHost: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => {});
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    if (!m?.[1] || !m[2]) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const port = Number(m[2]);
    const d = await decide(m[1], port);
    decisions.push({ kind: 'connect', target: req.url ?? '', allowed: d.ok, reason: d.ok ? undefined : d.reason, address: d.address });
    if (!d.ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect({ host: d.address, port, timeout });
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  // 프록시로 직접 들어오는 WebSocket 업그레이드(ws://)는 허용하지 않는다
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    decisions.push({ kind: 'upgrade', target: req.url ?? '', allowed: false, reason: 'websocket-not-allowed' });
    socket.destroy();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    decisions,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
