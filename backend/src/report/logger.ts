import { maskText } from './mask.ts';

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
};

/** 진행 로그는 stderr로, 비밀값은 마스킹해서 출력한다 */
export function createLogger({ verbose = false, write = (s: string) => process.stderr.write(s) } = {}): Logger {
  const out = (level: string, msg: string) => write(`[${level}] ${maskText(msg)}\n`);
  return {
    info: (m) => out('info', m),
    warn: (m) => out('warn', m),
    debug: (m) => {
      if (verbose) out('debug', m);
    },
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, debug() {} };
