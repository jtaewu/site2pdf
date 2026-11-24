// 산출 JSON의 공통 메타데이터와 차단 내역 요약
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BlockedRequest } from '../browser/context.ts';
import type { EgressDecision } from '../fetch-policy/egress-proxy.ts';
import type { RobotsPolicy } from '../discover/robots.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
export const TOOL = { name: pkg.name, version: pkg.version };

export const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${crypto.randomBytes(3).toString('hex')}`;

export function summarizeBlocked(blocked: BlockedRequest[]) {
  const m = new Map<string, { type: string; origin: string; count: number; example: string }>();
  for (const b of blocked) {
    let origin = b.url;
    try {
      origin = new URL(b.url).origin;
    } catch {}
    const k = `${b.type} ${origin}`;
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { type: b.type, origin, count: 1, example: b.url });
  }
  return [...m.values()];
}

export function summarizeEgressDenied(decisions: EgressDecision[]) {
  const m = new Map<string, { target: string; reason: string; count: number }>();
  for (const d of decisions.filter((x) => !x.allowed)) {
    const target = d.kind === 'connect' ? d.target : d.target.split('/')[0]!;
    const k = `${target} ${d.reason}`;
    const cur = m.get(k);
    if (cur) cur.count++;
    else m.set(k, { target, reason: d.reason ?? '', count: 1 });
  }
  return [...m.values()];
}

export function robotsSummary(r: RobotsPolicy) {
  if (r.state === 'present') return { state: r.state, crawlDelaySec: r.crawlDelaySec ?? null };
  return r;
}

/** 출력 폴더 안에 JSON 파일을 쓴다 */
export function writeJson(outputDir: string, name: string, data: unknown): string {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
