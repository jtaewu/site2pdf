// PoC 6: 로컬 모드 파일 경계 — 경로 탈출/인코딩 우회/심볼릭 링크가 루트 밖 파일을 읽는지 확인
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { startFixtureServer } from './lib/server.mjs';

// URL 정규화 없이 원문 경로 그대로 보내기 위한 raw 요청
const raw = (origin, p) => new Promise(resolve => {
  const u = new URL(origin);
  const req = http.request({ host: u.hostname, port: u.port, path: p, method: 'GET' }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, leaked: b.includes('OUTSIDE_SECRET') })); });
  req.on('error', e => resolve({ status: 'error', error: e.code }));
  req.end();
});

export async function run() {
  // 임시 루트: site/ 안에 정상 파일, 바깥에 비밀 파일, site/ 안에 바깥을 가리키는 심볼릭 링크 시도
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-local-'));
  const site = path.join(tmp, 'site');
  fs.mkdirSync(path.join(site, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(site, 'docs', 'index.html'), '<h1>ok</h1>');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'OUTSIDE_SECRET');
  let symlink = 'created';
  try { fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(site, 'docs', 'link.txt')); }
  catch (e) { symlink = `not-created (${e.code}: Windows 개발자 모드/관리자 권한 필요)`; }
  let junction = 'created';
  try { fs.symlinkSync(tmp, path.join(site, 'docs', 'jdir'), 'junction'); } catch (e) { junction = `not-created (${e.code})`; }

  const srv = await startFixtureServer({ root: site });
  const cases = ['/docs/index.html', '/../secret.txt', '/docs/../../secret.txt', '/%2e%2e/secret.txt', '/docs/%2e%2e%2f%2e%2e%2fsecret.txt',
    '/docs/..%5c..%5csecret.txt', '/..\\secret.txt', '/docs/link.txt', '/docs/jdir/secret.txt', '/C:/Windows/win.ini', '/%00'];
  const results = [];
  for (const c of cases) results.push({ path: c, ...(await raw(srv.origin, c)) });
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  const res = { symlink, junction, results };
  fs.writeFileSync('../output/poc/local-boundary.json', JSON.stringify(res, null, 2));
  return res;
}

if (process.argv[1].endsWith('06-local-boundary.mjs')) {
  const r = await run();
  console.log(`symlink: ${r.symlink} / junction: ${r.junction}`);
  r.results.forEach(x => console.log(`  ${x.leaked ? 'LEAK ' : 'safe '} ${String(x.status).padEnd(5)} ${x.path}`));
}
