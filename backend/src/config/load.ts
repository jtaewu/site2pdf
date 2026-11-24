import { maskUrl } from '../report/mask.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configSchema, type Config } from './schema.ts';
import { ExitCode, Site2pdfError } from '../errors.ts';
import { normalizeOrigin, validateRemoteUrl } from '../fetch-policy/url.ts';

/** 원격 모드 요청 간격 하한 (00-ai-dev-guide 규칙 7: 공격적 부하 금지) */
export const REMOTE_MIN_DELAY_MS = 500;

export type CliInput = { configPath?: string; url?: string; source?: string };

const fail = (code: string, msg: string) => new Site2pdfError(ExitCode.INPUT, code, msg);

/**
 * 설정 파일 + CLI 입력을 합쳐 검증된 설정을 만든다.
 * --url 과 --source 는 상호 배타적이며, 지정 시 설정 파일의 입력값을 덮어쓴다.
 */
export function loadConfig(input: CliInput): { config: Config; configHash: string } {
  if (input.url && input.source) throw fail('input-conflict', '--url 과 --source 는 함께 쓸 수 없습니다.');
  let raw: Record<string, unknown> = {};
  let baseDir = process.cwd();
  if (input.configPath) {
    const file = path.resolve(input.configPath);
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      throw fail('config-unreadable', `설정 파일을 읽을 수 없습니다: ${file} (${(e as Error).message})`);
    }
    baseDir = path.dirname(file);
  }
  // CLI 입력이 모드를 정하면 다른 모드 전용 필드는 버린다
  if (input.url) raw = { ...omit(raw, LOCAL_ONLY), mode: 'remote', startUrl: input.url };
  if (input.source) {
    raw = { ...omit(raw, REMOTE_ONLY), mode: 'local', sourcePath: path.resolve(input.source) };
  } else if (raw.mode === 'local' && typeof raw.sourcePath === 'string') {
    raw.sourcePath = path.resolve(baseDir, raw.sourcePath);
  }
  if (!raw.mode) throw fail('input-missing', '--url, --source 또는 mode가 있는 --config 중 하나가 필요합니다.');

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw fail('config-invalid', `설정 검증 실패: ${issues}`);
  }
  const config = parsed.data;

  if (config.mode === 'remote') {
    const check = validateRemoteUrl(config.startUrl);
    if (!check.ok) throw fail('start-url-rejected', `시작 URL 거부(${check.reason}): ${maskUrl(config.startUrl)}`);
    config.startUrl = check.url;
    const startOrigin = normalizeOrigin(check.url);
    const origins = config.scope.allowedOrigins.map(safeOrigin);
    // MVP: 탐색 origin은 시작 URL origin 하나만 허용 (04-functional-spec §3)
    if (origins.some((o) => o !== startOrigin)) {
      throw fail('origin-not-allowed', `scope.allowedOrigins는 시작 URL origin(${startOrigin})만 허용합니다. 추가 origin은 승인 절차가 필요합니다.`);
    }
    config.scope.allowedOrigins = [startOrigin];
    config.resources.allowedOrigins = config.resources.allowedOrigins.map((o) => {
      const v = validateRemoteUrl(o);
      if (!v.ok) throw fail('resource-origin-rejected', `resources.allowedOrigins 거부(${v.reason}): ${maskUrl(o)}`);
      return normalizeOrigin(v.url);
    });
    if (config.crawl.minDelayMs < REMOTE_MIN_DELAY_MS) {
      throw fail('delay-too-short', `원격 모드 crawl.minDelayMs는 ${REMOTE_MIN_DELAY_MS}ms 이상이어야 합니다.`);
    }
  } else {
    if (!fs.existsSync(config.sourcePath) || !fs.statSync(config.sourcePath).isDirectory()) {
      throw fail('source-not-found', `로컬 사이트 폴더가 없습니다: ${config.sourcePath}`);
    }
    if (config.scope.allowedOrigins.length > 0) {
      throw fail('origin-not-allowed', '로컬 모드에서는 scope.allowedOrigins를 지정하지 않습니다(로컬 서버 origin이 자동 적용).');
    }
  }
  const configHash = crypto.createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16);
  return { config, configHash };
}

const LOCAL_ONLY = ['sourcePath', 'startPath', 'spaFallbackPrefix'];
const REMOTE_ONLY = ['startUrl', 'resources'];

function omit(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !keys.includes(k)));
}

function safeOrigin(o: string): string {
  try {
    return normalizeOrigin(o);
  } catch {
    throw fail('origin-invalid', `잘못된 origin: ${maskUrl(o)}`);
  }
}

/** 비교용 실제 경로 (없는 경로는 존재하는 상위까지 실제 경로로 바꾼 뒤 나머지를 붙인다, Windows는 대소문자 무시) */
function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  const real = path.join(fs.realpathSync.native(cur), ...rest);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * 출력 폴더 검증 (T-18): 파일이면 안 되고, 로컬 모드에서 원본 사이트 폴더 안이면 안 된다
 * (결과물이 다음 탐색 대상이 되거나 원본을 덮어쓸 수 있음).
 */
export function assertSafeOutputDir(config: Config, outputDir: string): void {
  if (fs.existsSync(outputDir) && !fs.statSync(outputDir).isDirectory()) {
    throw fail('output-not-directory', `출력 경로가 폴더가 아닙니다: ${outputDir}`);
  }
  if (config.mode === 'local') {
    const out = realish(outputDir);
    const src = realish(config.sourcePath);
    if (out === src || out.startsWith(src + path.sep)) {
      throw fail('output-inside-source', `출력 폴더가 원본 사이트 폴더 안에 있습니다. 다른 위치를 지정하세요: ${outputDir}`);
    }
  }
}

/** outputDir 아래 상대 경로를 안전하게 붙인다. 바깥으로 나가면 예외 (T-18) */
export function safeJoin(outputDir: string, rel: string): string {
  const base = path.resolve(outputDir);
  const full = path.resolve(base, rel);
  if (path.isAbsolute(rel) || (full !== base && !full.startsWith(base + path.sep))) {
    throw new Site2pdfError(ExitCode.SECURITY, 'output-path-escape', `출력 폴더 밖 경로로 쓰려고 했습니다: ${rel}`);
  }
  return full;
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
