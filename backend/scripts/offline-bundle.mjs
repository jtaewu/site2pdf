// 내부망(오프라인) 반입 패키지 생성기 — 인터넷 PC에서 실행
// 실행에 꼭 필요한 것만 모아 Node.js 내장 기능(gzip)으로 압축하고 190MB 조각으로 나눈다.
// Windows 기본 도구(tar, Expand-Archive, chcp)에 의존하지 않는다: 내부망 PC마다 버전·코드페이지가 달라 실패할 수 있기 때문.
//   - 소스: .git·poc·output·node_modules 제외
//   - 라이브러리: npm ci --omit=dev (테스트·개발 도구 제외)
//   - 브라우저: chromium_headless_shell·winldd만 (일반 Chromium 제외)
// 결과: site2pdf-offline.pack.001(…), restore.cmd(영문 전용), restore.mjs(복원기, 조각 SHA-256 내장), 안내.txt
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// 200MB 제한보다 작게. S2P_PART_MB 로 조각 크기 조절 가능(반입 제한이 더 작을 때·분할 시험용)
const PART_BYTES = (Number(process.env.S2P_PART_MB) || 190) * 1024 * 1024;
const MAGIC = 'S2PPACK1\n';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const outDir = path.resolve(process.argv[2] ?? 'C:\\site2pdf-offline');
const log = (m) => console.log(`[bundle] ${m}`);
const fail = (m) => {
  console.error(`[bundle] 오류: ${m}`);
  process.exit(1);
};

if (process.platform !== 'win32') fail('Windows용 패키지 생성기입니다(내부망 PC도 Windows 64비트여야 함).');

// 1) 브라우저 위치 확인
const browsersDir = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(repo, 'ms-playwright'), path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')]
  .filter(Boolean)
  .find((d) => fs.existsSync(d) && fs.readdirSync(d).some((n) => n.startsWith('chromium_headless_shell-')));
if (!browsersDir) fail('브라우저가 없습니다. 먼저 backend 폴더에서 npm.cmd run browser:install 을 실행하세요.');

// 2) 작업 폴더 준비
const work = fs.mkdtempSync(path.join(os.tmpdir(), 's2p-bundle-'));
const stage = path.join(work, 'site2pdf');
log(`작업 폴더: ${work}`);
const SKIP = new Set(['.git', 'poc', 'output', 'node_modules', '.tmp', 'ms-playwright']);
fs.cpSync(repo, stage, { recursive: true, filter: (src) => src === repo || !SKIP.has(path.basename(src)) });

// 3) 실행용 라이브러리만 설치
log('실행용 라이브러리 설치(npm ci --omit=dev)…');
const npm = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'], { cwd: path.join(stage, 'backend'), stdio: 'inherit' });
if (npm.status !== 0) fail('npm ci 실패 (인터넷 연결을 확인하세요)');

// 4) 브라우저(헤드리스 셸)만 복사
for (const name of fs.readdirSync(browsersDir)) {
  if (name.startsWith('chromium_headless_shell-') || name.startsWith('winldd-')) {
    log(`브라우저 복사: ${name}`);
    fs.cpSync(path.join(browsersDir, name), path.join(stage, 'ms-playwright', name), { recursive: true });
  }
}

// 5) 묶기: [MAGIC] + 반복 [u32 길이][JSON 헤더][파일 바이트] + 끝 표시, 전체 gzip
function* walk(dir, rel = '') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { p: r, d: true };
      yield* walk(full, r);
    } else if (e.isFile()) yield { p: r, s: fs.statSync(full).size, full };
  }
}
const header = (obj) => {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return Buffer.concat([len, json]);
};
let fileCount = 0;
async function* source() {
  yield Buffer.from(MAGIC);
  for (const e of walk(stage)) {
    if (e.d) {
      yield header({ p: e.p, d: true });
      continue;
    }
    fileCount++;
    yield header({ p: e.p, s: e.s });
    for await (const chunk of fs.createReadStream(e.full, { highWaterMark: 1024 * 1024 })) yield chunk;
  }
  yield header({ end: true, files: fileCount });
}

// 6) 190MB 조각으로 나눠 쓰며 조각별 SHA-256 계산
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^site2pdf-offline\.(pack|zip)\.\d{3}$/.test(f)) fs.rmSync(path.join(outDir, f));
const parts = [];
let cur = null;
const open = () => {
  const name = `site2pdf-offline.pack.${String(parts.length + 1).padStart(3, '0')}`;
  cur = { name, fd: fs.openSync(path.join(outDir, name), 'w'), size: 0, hash: crypto.createHash('sha256') };
  parts.push(cur);
};
const close = () => {
  fs.closeSync(cur.fd);
  cur.sha256 = cur.hash.digest('hex');
};
const splitter = new Writable({
  write(chunk, _enc, cb) {
    let off = 0;
    while (off < chunk.length) {
      if (!cur || cur.size >= PART_BYTES) {
        if (cur) close();
        open();
      }
      const n = Math.min(chunk.length - off, PART_BYTES - cur.size);
      const piece = chunk.subarray(off, off + n);
      fs.writeSync(cur.fd, piece);
      cur.hash.update(piece);
      cur.size += n;
      off += n;
    }
    cb();
  },
  final(cb) {
    if (cur) close();
    cb();
  },
});
log('압축 중… (몇 분 걸릴 수 있음)');
await pipeline(Readable.from(source()), zlib.createGzip({ level: 9 }), splitter);

// 7) 복원기·실행기·안내문
const partsInfo = parts.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 }));
const restoreSrc = fs.readFileSync(path.join(here, 'offline-restore.mjs'), 'utf8').replace('/*__PARTS__*/[]', JSON.stringify(partsInfo, null, 2));
fs.writeFileSync(path.join(outDir, 'restore.mjs'), restoreSrc, 'utf8');
// restore.cmd 는 ASCII 전용 (내부망 PC의 코드페이지와 무관하게 동작하도록). 한글 안내는 Node가 출력한다.
const restoreCmd = [
  '@echo off',
  'setlocal',
  'cd /d "%~dp0"',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo [ERROR] Node.js is not installed. Install Node.js 24 LTS first, then run restore.cmd again.',
  '  pause',
  '  exit /b 1',
  ')',
  'node "%~dp0restore.mjs" %*',
  'echo.',
  'pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(outDir, 'restore.cmd'), restoreCmd, 'ascii');
const guide = [
  'site2pdf 내부망 반입 패키지',
  '',
  '[옮길 파일] 아래 파일을 옮기면 됩니다 (각 200MB 미만).',
  ...parts.map((p) => `  - ${p.name}  (${(p.size / 1024 / 1024).toFixed(1)}MB)`),
  '  - restore.cmd, restore.mjs, 안내.txt',
  '  - Node.js 24 LTS 설치 파일 (nodejs.org, Windows 64-bit .msi) — 따로 준비',
  '',
  '[내부망 PC에서]',
  '  1. Node.js 설치 파일 실행 (다음 → 완료)',
  '  2. 옮긴 파일을 모두 한 폴더에 모은다 (예: C:\\site2pdf-offline)',
  '  3. restore.cmd 를 더블클릭 → C:\\site2pdf 에 설치되고 샘플 변환까지 자동 확인',
  '     (다른 위치: 명령 프롬프트에서 restore.cmd D:\\tools\\site2pdf)',
  '  4. 새 PowerShell 창에서:',
  '       cd C:\\site2pdf',
  '       .\\site2pdf.cmd generate --source C:\\sample-site -o C:\\result',
  '     결과: C:\\result\\pdf\\site-combined.pdf',
  '',
  `생성: ${new Date().toISOString()}  /  ${fileCount}개 파일, ${parts.length}조각`,
  '',
].join('\r\n');
fs.writeFileSync(path.join(outDir, '안내.txt'), `\ufeff${guide}`, 'utf8');

fs.rmSync(work, { recursive: true, force: true });
log(`완료: ${outDir}`);
for (const p of parts) log(`  ${p.name}  ${(p.size / 1024 / 1024).toFixed(1)}MB`);
log('  restore.cmd, restore.mjs, 안내.txt');
