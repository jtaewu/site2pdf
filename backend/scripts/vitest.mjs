// Windows에서 작업 폴더가 소문자 드라이브(c:\)로 열리면 vitest 모듈이 서로 다른 경로로 두 번 로드되어
// "Vitest failed to find the runner" 오류가 난다. 실제 대소문자 경로(C:\)에서 vitest를 실행한다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const cwd = fs.realpathSync.native(process.cwd());
const bin = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
