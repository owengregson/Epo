/** Offline, seeded before/after audit of the SessionPlanner's busy-session gaps. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const replacement = 'return this.cfg.gapFloorMs + Math.round(discretionary / excitation);';
const historical = 'return Math.max(this.cfg.gapFloorMs, Math.round(base / excitation));';

async function loadPlanner(previous) {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { SessionPlanner } from './src/timing/session-planner';
        export { actionGap } from './src/timing/action-gap';
        export { mulberry32 } from './src/timing/noise';
        export { DEFAULT_SETTINGS, toPacingConfig } from './src/settings/settings';
        export { patternCircadianProfile } from './src/settings/pattern-map';`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: previous ? [{
      name: 'previous-gap-formula',
      setup(bundler) {
        bundler.onLoad({ filter: /session-planner\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          if (!source.includes(replacement)) throw new Error('Gap formula changed; review the QC baseline.');
          return { contents: source.replace(replacement, historical), loader: 'ts' };
        });
      },
    }] : [],
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

const [before, after] = await Promise.all([loadPlanner(true), loadPlanner(false)]);
const samples = 50_000;
const seed = 20260921;
const now = new Date(2026, 8, 21, 12).getTime();
const cfg = after.toPacingConfig(after.DEFAULT_SETTINGS);
const profile = after.patternCircadianProfile(after.DEFAULT_SETTINGS.pattern, 0);

function measure(runtime, recentCount) {
  const planner = new runtime.SessionPlanner({ cfg, profile, rng: runtime.mulberry32(seed) });
  planner.advance(now);
  for (let index = 0; index < recentCount; index++) planner.recordAction(now, 'follow');
  const gaps = Array.from({ length: samples }, () => planner.nextActionGapMs(now));
  const sorted = [...gaps].sort((a, b) => a - b);
  return {
    exactFloorPct: gaps.filter((gap) => gap === cfg.gapFloorMs).length / samples * 100,
    distinctMsPct: new Set(gaps).size / samples * 100,
    meanMs: Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / samples),
    medianMs: sorted[Math.floor(samples / 2)],
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

const gapRng = after.mulberry32(seed);
const legacyGaps = Array.from({ length: samples }, () => after.actionGap(60_000, 60_000, 0).sample(gapRng));
console.log(JSON.stringify({
  kind: 'offline-seeded-simulation', seed, samplesPerScenario: samples, cfg,
  equalBoundLegacyGap: {
    configuredMs: 60_000, beforeDistinctValues: 1,
    afterDistinctValues: new Set(legacyGaps).size,
    minMs: Math.min(...legacyGaps), maxMs: Math.max(...legacyGaps),
  },
  scenarios: [0, 1, 3, 10].map((recentActions) => ({
    recentActions, before: measure(before, recentActions), after: measure(after, recentActions),
  })),
}, null, 2));
