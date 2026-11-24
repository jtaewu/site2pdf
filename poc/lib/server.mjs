// PoC용 fixture 서버. 루프백(127.0.0.1)에만 바인딩하고, 루트 밖 파일(경로 탈출·심볼릭 링크)을 거부한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.xml': 'application/xml' };

export function startFixtureServer({ root, spaPrefix = null, vars = {}, routes = {} }) {
  const realRoot = fs.realpathSync(root);
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ method: req.method, url: req.url });
    if (routes[u.pathname]) return routes[u.pathname](req, res, u);
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(realRoot, '.' + rel);
    if (spaPrefix && u.pathname.startsWith(spaPrefix)) file = path.join(realRoot, 'index.html');
    let real;
    try { real = fs.realpathSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    // 루트 밖 접근 차단(../ 또는 심볼릭 링크로 바깥을 가리키는 경우)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    if (fs.statSync(real).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    let body = fs.readFileSync(real);
    const type = TYPES[path.extname(real)] || 'application/octet-stream';
    if (/^(text|application\/xml)/.test(type)) {
      let s = body.toString('utf8');
      for (const [k, v] of Object.entries(vars)) s = s.split(k).join(typeof v === 'function' ? v(u) : v);
      body = Buffer.from(s, 'utf8');
    }
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ origin, log, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}

// 범위 밖 목적지 역할을 하는 sentinel 서버: 들어온 모든 요청(HTTP/WebSocket 업그레이드)을 기록한다.
export function startSentinel() {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('sentinel'); });
  server.on('upgrade', (req, sock) => { hits.push(`UPGRADE ${req.url}`); sock.destroy(); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    resolve({ origin, hits, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
