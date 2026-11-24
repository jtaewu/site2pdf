// 로컬 모드 정적 서버 (ADR-004 로컬 경계, T-16).
// 127.0.0.1에만 바인딩, GET/HEAD만, realpath로 루트 밖(경로 탈출·심볼릭 링크·junction) 차단, 숨김 파일 차단.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type net from 'node:net';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
};

export type StaticServer = { origin: string; root: string; close(): Promise<void> };

export type StaticServerOptions = {
  /** SPA History 라우팅: 이 prefix 아래의 없는 경로는 index.html로 응답 */
  spaFallbackPrefix?: string;
};

/** 루트 안 파일이면 실제 경로, 아니면 null */
export function resolveInsideRoot(realRoot: string, urlPath: string): { file: string } | { status: 403 | 404 } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { status: 404 };
  }
  if (decoded.includes('\0')) return { status: 404 };
  if (decoded.endsWith('/')) decoded += 'index.html';
  // 숨김 파일/폴더(.git, .env 등) 차단
  if (decoded.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) return { status: 404 };
  const candidate = path.resolve(realRoot, `.${path.sep}${decoded}`);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { status: 404 };
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { status: 403 };
  if (!fs.statSync(real).isFile()) return { status: 404 };
  return { file: real };
}

export async function startStaticServer(root: string, opts: StaticServerOptions = {}): Promise<StaticServer> {
  const realRoot = fs.realpathSync(root);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const pathname = new URL(req.url ?? '/', 'http://local').pathname;
    let r = resolveInsideRoot(realRoot, pathname);
    if ('status' in r && r.status === 404 && opts.spaFallbackPrefix && pathname.startsWith(opts.spaFallbackPrefix)) {
      r = resolveInsideRoot(realRoot, '/index.html');
    }
    if ('status' in r) {
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8' }).end(r.status === 403 ? 'forbidden' : 'not found');
      return;
    }
    const type = TYPES[path.extname(r.file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(r.file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    root: realRoot,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
