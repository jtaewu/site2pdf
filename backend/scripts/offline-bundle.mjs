// 내부망(오프라인) 반입 패키지 생성기
// 인터넷 PC에서 실행: 실행에 꼭 필요한 것만 모아(zip) 190MB 조각으로 나누고, 내부망에서 더블클릭으로 복원하는 restore.cmd를 만든다.
//   - 소스: .git·poc·output·node_modules 제외
//   - 라이브러리: npm ci --omit=dev (테스트·개발 도구 제외)
//   - 브라우저: chromium_headless_shell·winldd만 (일반 Chromium 제외)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PART_BYTES = 190 * 1024 * 1024; // 200MB 제한보다 작게
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
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
fs.cpSync(repo, stage, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) || src === repo });

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

// 5) zip 압축 (Windows 기본 tar.exe)
const zip = path.join(work, 'site2pdf-offline.zip');
log('압축 중… (몇 분 걸릴 수 있음)');
execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', stage, '.'], { stdio: 'inherit' });

// 6) 190MB 조각으로 나누기
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^site2pdf-offline\.zip\.\d{3}$/.test(f)) fs.rmSync(path.join(outDir, f));
const total = fs.statSync(zip).size;
const fd = fs.openSync(zip, 'r');
const parts = [];
const buf = Buffer.alloc(8 * 1024 * 1024);
for (let off = 0, i = 1; off < total; i++) {
  const name = `site2pdf-offline.zip.${String(i).padStart(3, '0')}`;
  const out = fs.openSync(path.join(outDir, name), 'w');
  let written = 0;
  while (written < PART_BYTES && off < total) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, PART_BYTES - written, total - off), off);
    fs.writeSync(out, buf, 0, n);
    written += n;
    off += n;
  }
  fs.closeSync(out);
  parts.push({ name, size: written });
}
fs.closeSync(fd);

// 7) 복원 스크립트·안내문
const join = parts.map((p) => `"${p.name}"`).join('+');
const restore = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'set "DEST=C:\\site2pdf"',
  'if not "%~1"=="" set "DEST=%~1"',
  'cd /d "%~dp0"',
  'echo [1/4] Node.js 확인',
  'where node >nul 2>nul || (echo Node.js 24 가 설치되어 있지 않습니다. 먼저 Node.js 설치 파일을 실행하세요. & pause & exit /b 1)',
  ...parts.map((p) => `if not exist "${p.name}" (echo 조각 파일이 없습니다: ${p.name} & pause & exit /b 1)`),
  'echo [2/4] 조각 합치기',
  `copy /b ${join} "%TEMP%\\site2pdf-offline.zip" >nul || (echo 합치기 실패 & pause & exit /b 1)`,
  'echo [3/4] 압축 풀기: %DEST%',
  'if not exist "%DEST%" mkdir "%DEST%"',
  'tar.exe -xf "%TEMP%\\site2pdf-offline.zip" -C "%DEST%" 2>nul || powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath $env:TEMP\\site2pdf-offline.zip -DestinationPath $env:DEST" || (echo 압축 풀기 실패 & pause & exit /b 1)',
  'del "%TEMP%\\site2pdf-offline.zip"',
  'if not defined S2P_NO_SETX setx PLAYWRIGHT_BROWSERS_PATH "%DEST%\\ms-playwright" >nul',
  'set "PLAYWRIGHT_BROWSERS_PATH=%DEST%\\ms-playwright"',
  'echo [4/4] 동작 확인 (샘플 사이트 변환)',
  'call "%DEST%\\site2pdf.cmd" generate -c "%DEST%\\config\\examples\\local-static.json" -o "%TEMP%\\site2pdf-selftest"',
  'if errorlevel 1 (echo 동작 확인 실패: 위 메시지를 담당자에게 전달하세요 & pause & exit /b 1)',
  'echo.',
  'echo 설치 완료: %DEST%',
  'echo 새 PowerShell 창에서: cd %DEST% 후  .\\site2pdf.cmd generate --source C:\\sample-site -o C:\\result',
  'pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(outDir, 'restore.cmd'), restore, 'utf8');

const guide = [
  'site2pdf 내부망 반입 패키지',
  '',
  '[옮길 파일] 아래 파일을 한 번에 하나씩 옮기면 됩니다 (각 200MB 미만).',
  ...parts.map((p) => `  - ${p.name}  (${(p.size / 1024 / 1024).toFixed(1)}MB)`),
  '  - restore.cmd, 안내.txt',
  '  - Node.js 24 LTS 설치 파일 (nodejs.org, Windows 64-bit .msi) — 따로 준비',
  '',
  '[내부망 PC에서]',
  '  1. Node.js 설치 파일 실행 (다음 → 완료)',
  '  2. 옮긴 파일을 모두 한 폴더에 모은다 (예: C:\\site2pdf-offline)',
  '  3. restore.cmd 를 더블클릭 → C:\\site2pdf 에 설치되고 샘플 변환까지 자동 확인',
  '  4. 새 PowerShell 창에서:',
  '       cd C:\\site2pdf',
  '       .\\site2pdf.cmd generate --source C:\\sample-site -o C:\\result',
  '     결과: C:\\result\\pdf\\site-combined.pdf',
  '',
  `생성: ${new Date().toISOString()}  /  전체 ${(total / 1024 / 1024).toFixed(1)}MB, ${parts.length}조각`,
  '',
].join('\r\n');
fs.writeFileSync(path.join(outDir, '안내.txt'), `\ufeff${guide}`, 'utf8');

fs.rmSync(work, { recursive: true, force: true });
log(`완료: ${outDir}`);
for (const p of parts) log(`  ${p.name}  ${(p.size / 1024 / 1024).toFixed(1)}MB`);
log('  restore.cmd, 안내.txt');
