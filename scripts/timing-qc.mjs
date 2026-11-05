/**
 * Offline, seeded audit of the plan's in-session gaps: the reference shape the engine arms at
 * time-scale 1 (by how many actions the trailing hour already holds) and one plan-day's session
 * gap specs on the default settings. Zero Instagram traffic; prints JSON.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const bundled = await build({
  absWorkingDir: root,
  stdin: {
    contents: `export { referenceGapMs } from './src/engine/pacers';
      export { drawDayPlan, phaseOffsetHours, planDayWindow, quietMinute } from './src/kernel/plan';
      export { mulberry32 } from './src/kernel/rng';
      export { DEFAULT_SETTINGS } from './src/settings/settings';
      export { effectiveFromV1 } from './src/settings/effective';
      export { toPlanIntent } from './src/settings/plan-intent';`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const module = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0].text)(module, module.exports, require);
const m = module.exports;

const samples = 50_000;
const seed = 20260921;
const now = new Date(2026, 8, 21, 12).getTime();
const intent = m.toPlanIntent(m.effectiveFromV1(m.DEFAULT_SETTINGS));

function measure(recentActions) {
  const rng = m.mulberry32(seed);
  const recent = Array.from({ length: recentActions }, () => now);
  const gaps = Array.from({ length: samples }, () => m.referenceGapMs(intent, recent, now, rng));
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    recentActions,
    exactFloorPct: (gaps.filter((gap) => gap === intent.gap.floorMs).length / samples) * 100,
    distinctMsPct: (new Set(gaps).size / samples) * 100,
    meanMs: Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / samples),
    medianMs: sorted[Math.floor(samples / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

const phase = m.phaseOffsetHours(seed);
const window = m.planDayWindow(now, m.quietMinute(intent.shape, phase, intent.quietHours));
const demand = {
  lifecycleDueByDayEnd: 0, lifecycleBacklog: 0, pruneStock: 0, protectedReeval: 0, journalPending: 0,
  followsDoneToday: 0, outsideToday: 0, pendingRequests: 0, acceptsRecent: 0,
  ownHeader: { followers: null, following: null }, census: { lastCompleteAt: null, rowsPerPage: null },
};
const plan = m.drawDayPlan({
  installEntropy: seed, window, intent, demand, phaseOffsetHours: phase, firstOpenAt: window.startsAt, boost: null,
  runIntent: 'running',
});

console.log(JSON.stringify({
  kind: 'offline-seeded-simulation',
  seed,
  samplesPerScenario: samples,
  referenceShape: intent.gap,
  scenarios: [0, 1, 3, 10].map(measure),
  planDay: {
    key: plan.window.key,
    volume: plan.volume,
    sessions: plan.sessions.map((s) => ({
      idx: s.idx, budget: s.budget, pace: s.tempo.pace, timeScale: s.tempo.gap.timeScale,
      targetMeanMs: Math.round(s.tempo.gap.targetMeanMs), medianMs: s.tempo.gap.medianMs, floorMs: s.tempo.gap.floorMs,
    })),
  },
}, null, 2));
