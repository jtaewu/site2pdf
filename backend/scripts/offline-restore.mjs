// site2pdf 내부망 복원기 (offline-bundle.mjs가 조각 목록·SHA-256을 채워 restore.mjs로 내보낸다)
// Node.js 내장 기능만 사용: 조각 확인 → 합치며 풀기 → 브라우저 경로 설정 → 샘플 변환으로 동작 확인
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const PARTS = /*__PARTS__*/[];
const MAGIC = 'S2PPACK1\n';
const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] ?? 'C:\\site2pdf');
const say = (m) => console.log(m);
const fail = (m) => {
  console.error(`\n[실패] ${m}`);
  process.exit(1);
};

say(`site2pdf 설치 위치: ${dest}\n`);

// 1) Node 버전
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) fail(`Node.js 24 이상이 필요합니다(현재 ${process.version}). Node.js 24 LTS를 설치한 뒤 다시 실행하세요.`);
say(`[1/5] Node.js ${process.version} 확인`);

// 2) 조각 확인 (옮기는 중 손상 여부)
if (!PARTS.length) fail('조각 목록이 비어 있습니다. make-offline-bundle.cmd 로 만든 restore.mjs 를 쓰세요.');
say(`[2/5] 조각 파일 ${PARTS.length}개 확인 중…`);
for (const p of PARTS) {
  const f = path.join(here, p.name);
  if (!fs.existsSync(f)) fail(`조각 파일이 없습니다: ${p.name}\n       restore.cmd 와 같은 폴더에 모든 조각을 넣어 주세요.`);
  const size = fs.statSync(f).size;
  if (size !== p.size) fail(`조각 크기가 다릅니다(옮기는 중 잘림): ${p.name} ${size} / 정상 ${p.size} 바이트. 다시 옮겨 주세요.`);
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(f)) hash.update(c);
  if (hash.digest('hex') !== p.sha256) fail(`조각 내용이 손상되었습니다: ${p.name}. 다시 옮겨 주세요.`);
  say(`       ${p.name} 정상`);
}

// 3) 합치며 풀기
say(`[3/5] 압축 풀기 → ${dest}`);
async function* joined() {
  for (const p of PARTS) for await (const c of fs.createReadStream(path.join(here, p.name), { highWaterMark: 4 * 1024 * 1024 })) yield c;
}
const safePath = (rel) => {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return null;
  const full = path.resolve(dest, ...rel.split('/'));
  return full.startsWith(dest + path.sep) ? full : null;
};
fs.mkdirSync(dest, { recursive: true });
let buf = Buffer.alloc(0);
let state = 'magic';
let current = null; // { fd, left }
let files = 0;
let ended = false;
const gunzip = Readable.from(joined()).pipe(zlib.createGunzip());
try {
  for await (const chunk of gunzip) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (state === 'magic') {
        if (buf.length < MAGIC.length) break;
        if (buf.subarray(0, MAGIC.length).toString() !== MAGIC) fail('반입 패키지 형식이 아닙니다.');
        buf = buf.subarray(MAGIC.length);
        state = 'header';
      } else if (state === 'header') {
        if (buf.length < 4) break;
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const h = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
        buf = buf.subarray(4 + len);
        if (h.end) {
          if (h.files !== files) fail(`파일 수가 맞지 않습니다(${files}/${h.files}).`);
          ended = true;
          state = 'done';
          break;
        }
        const full = safePath(h.p);
        if (!full) fail(`잘못된 경로가 들어 있습니다: ${h.p}`);
        if (h.d) {
          fs.mkdirSync(full, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        current = { fd: fs.openSync(full, 'w'), left: h.s };
        files++;
        if (files % 500 === 0) say(`       ${files}개 파일…`);
        state = 'data';
      } else if (state === 'data') {
        const n = Math.min(current.left, buf.length);
        if (n > 0) fs.writeSync(current.fd, buf, 0, n);
        current.left -= n;
        buf = buf.subarray(n);
        if (current.left > 0) break;
        fs.closeSync(current.fd);
        current = null;
        state = 'header';
      } else break;
    }
  }
} catch (e) {
  fail(`압축 풀기 중 오류: ${e.message}`);
}
if (!ended) fail('패키지가 중간에 끝났습니다(조각 누락 가능). 다시 옮겨 주세요.');
say(`       ${files}개 파일 설치 완료`);

// 4) 브라우저 경로 (사용자 환경 변수)
const browsers = path.join(dest, 'ms-playwright');
say('[4/5] 브라우저 경로 설정');
if (!process.env.S2P_NO_SETX) {
  try {
    execFileSync('setx', ['PLAYWRIGHT_BROWSERS_PATH', browsers], { stdio: 'ignore' });
  } catch {
    say(`       (자동 설정 실패) 직접 실행하세요: setx PLAYWRIGHT_BROWSERS_PATH "${browsers}"`);
  }
}

// 5) 샘플 변환으로 동작 확인
say('[5/5] 동작 확인: 샘플 사이트 변환 (30초~1분)');
const testOut = path.join(os.tmpdir(), 'site2pdf-selftest');
const r = spawnSync(process.execPath, [path.join(dest, 'backend', 'scripts', 'cli.mjs'), 'generate', '-c', path.join(dest, 'config', 'examples', 'local-static.json'), '-o', testOut], {
  stdio: 'inherit',
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
});
if (r.status !== 0) fail('동작 확인 실패. 위 메시지를 담당자에게 전달하세요.');
fs.rmSync(testOut, { recursive: true, force: true });

say(`\n설치 완료: ${dest}`);
say('이제 새 PowerShell 창을 열고:');
say(`  cd ${dest}`);
say('  .\\site2pdf.cmd generate --source C:\\sample-site -o C:\\result');
