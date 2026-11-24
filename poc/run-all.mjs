// Phase 0 PoC 전체 실행 → output/poc/summary.json
import fs from 'node:fs';
import { run as discover } from './01-discover.mjs';
import { run as render } from './02-render.mjs';
import { run as merge } from './03-merge.mjs';
import { run as security } from './04-security.mjs';
import { run as egress } from './05-egress-proxy.mjs';
import { run as local } from './06-local-boundary.mjs';
import { launch } from './lib/browser.mjs';

const t0 = Date.now();
const b = await launch(); const browserVersion = b.version(); await b.close();
const d = await discover();
const r = await render();
const m = await merge();
const s = await security();
const e = await egress();
const l = await local();

const pageStat = v => v.pages ? { stop: v.stopReason, pages: v.pages.length, excluded: v.excluded.length } : v.length;
const summary = {
  generatedAt: new Date().toISOString(),
  env: { node: process.version, browser: `Chrome ${browserVersion}`, playwrightCore: JSON.parse(fs.readFileSync('node_modules/playwright-core/package.json')).version, os: process.platform },
  discover: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, pageStat(v)])),
  render: Object.fromEntries(Object.entries(r).map(([k, list]) => [k, list.map(x => x.error ? { url: x.url, error: x.error } : { url: x.url, pages: x.pdfPages, coverage: x.coverage.ratio, overflow: x.overflow.count, notes: x.notes.join(',') })])),
  merge: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { pages: v.pages, outline: v.outline.length, internalLinks: v.links.internal, uriLinks: v.links.uri, sizeKB: v.sizeKB }])),
  security: s.levels.map(l => ({ level: l.level, sentinelHits: l.hitCount, leaked: l.sentinelHits })),
  egress: e.scenarios.map(x => ({ name: x.name, sentinelHits: x.sentinelHits.length })),
  localBoundary: { leaks: l.results.filter(x => x.leaked).length, cases: l.results.length, symlink: l.symlink, junction: l.junction },
  elapsedMs: Date.now() - t0,
};
fs.writeFileSync('../output/poc/summary.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
