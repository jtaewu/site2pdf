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
  const isHidden = (p: string) => p.split(/[\\/]/).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
  // 숨김 파일/폴더(.git, .env 등) 차단
  if (isHidden(decoded)) return { status: 404 };
  let root: string;
  let real: string;
  try {
    // native realpath: Windows 8.3 짧은 이름(GIT~1)을 실제 이름으로 바꿔 숨김 검사 우회를 막는다 (보안 감사 #3)
    root = fs.realpathSync.native(realRoot);
    real = fs.realpathSync.native(path.resolve(root, `.${path.sep}${decoded}`));
  } catch {
    return { status: 404 };
  }
  const caseFold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  if (caseFold(real) !== caseFold(root) && !caseFold(real).startsWith(caseFold(root + path.sep))) return { status: 403 };
  // 실제 경로 기준으로 숨김 검사를 다시 한다
  if (isHidden(path.relative(root, real))) return { status: 404 };
  if (!fs.statSync(real).isFile()) return { status: 404 };
  return { file: real };
}

export async function startStaticServer(root: string, opts: StaticServerOptions = {}): Promise<StaticServer> {
  const realRoot = fs.realpathSync.native(root);
  let expectedHost = '';
  const server = http.createServer((req, res) => {
    // Host 검사: 다른 브라우저가 DNS 재바인딩으로 이 임시 서버를 읽지 못하게 (보안 감사 #7)
    if (req.headers.host !== expectedHost) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('misdirected request');
      return;
    }
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
  expectedHost = `127.0.0.1:${port}`;
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
