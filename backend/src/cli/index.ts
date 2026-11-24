// site2pdf CLI (Phase 1: audit, discover). 실행 진입점은 bin.ts
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/load.ts';
import { ExitCode, Site2pdfError } from '../errors.ts';
import { runAudit } from '../audit/command.ts';
import { runDiscover } from '../discover/command.ts';
import { createLogger } from '../report/logger.ts';
import { maskText } from '../report/mask.ts';
import { TOOL } from '../report/summary.ts';

const HELP = `site2pdf ${TOOL.version}

사용법:
  site2pdf audit    (--url <https URL> | --source <폴더>) [--config <파일>] [--output <폴더>]
  site2pdf discover (--url <https URL> | --source <폴더>) [--config <파일>] [--output <폴더>]

옵션:
  --url <URL>             원격 HTTPS 사이트 (소유 또는 명시적 수집 권한이 있는 사이트만)
  --source <폴더>         로컬 정적 사이트 빌드 폴더 (외부 네트워크 사용 안 함)
  -c, --config <파일>     설정 JSON (config/examples 참고)
  -o, --output <폴더>     결과 폴더 (기본: ./output)
  --browser-channel <c>   개발용: 시스템 브라우저 사용(chrome|msedge). 기본은 전용 Chromium
  -v, --verbose           상세 로그
  -h, --help              도움말

종료 코드: 0 성공, 2 입력·설정·권한 문제, 3 탐색 실패, 4 보안 정책 위반
`;

export async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        source: { type: 'string' },
        config: { type: 'string', short: 'c' },
        output: { type: 'string', short: 'o', default: 'output' },
        'browser-channel': { type: 'string' },
        verbose: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return ExitCode.INPUT;
  }
  const { values, positionals } = args;
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? ExitCode.OK : ExitCode.INPUT;
  }
  if (command !== 'audit' && command !== 'discover') {
    process.stderr.write(`알 수 없는 명령: ${command}\n\n${HELP}`);
    return ExitCode.INPUT;
  }
  const channel = values['browser-channel'];
  if (channel !== undefined && channel !== 'chrome' && channel !== 'msedge') {
    process.stderr.write('--browser-channel 은 chrome 또는 msedge 만 허용합니다.\n');
    return ExitCode.INPUT;
  }
  const log = createLogger({ verbose: values.verbose });
  try {
    const { config, configHash } = loadConfig({ configPath: values.config, url: values.url, source: values.source });
    const outputDir = path.resolve(values.output);
    const opts = { channel: channel as 'chrome' | 'msedge' | undefined, log };
    if (command === 'audit') {
      const r = await runAudit(config, configHash, outputDir, opts);
      for (const f of r.findings) log.info(`진단: ${f}`);
      log.info(`결과: ${r.file} (종료 코드 ${r.exitCode})`);
      return r.exitCode;
    }
    const r = await runDiscover(config, configHash, outputDir, opts);
    (r.exitCode === ExitCode.OK ? log.info : log.warn)(r.message);
    log.info(`결과: ${r.file} (종료 코드 ${r.exitCode})`);
    return r.exitCode;
  } catch (e) {
    if (e instanceof Site2pdfError) {
      log.warn(`${e.code}: ${e.message}`);
      return e.exitCode;
    }
    process.stderr.write(`예상하지 못한 오류: ${maskText((e as Error).stack ?? String(e))}\n`);
    return ExitCode.RUN;
  }
}
