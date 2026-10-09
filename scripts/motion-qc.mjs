#!/usr/bin/env node
/** Seeded, offline motion comparison; does not open Instagram or dispatch input. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'baseline-ref': { type: 'string', default: 'HEAD' },
  samples: { type: 'string', default: '500' },
  out: { type: 'string' },
  help: { type: 'boolean', default: false },
} });

if (values.help) {
  console.log('Usage: node scripts/motion-qc.mjs [--baseline-ref HEAD] [--samples 500] [--out report.json]');
  process.exit(0);
}
const samples = Number(values.samples);
if (!Number.isInteger(samples) || samples < 1 || samples > 10_000) {
  throw new RangeError('--samples must be an integer from 1 to 10000');
}
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const baselineCommit = git('rev-parse', '--verify', '--end-of-options', `${values['baseline-ref']}^{commit}`).trim();

/** Read the baseline AND its relative dependencies from the same committed tree. */
function baselinePlugin(commit) {
  return {
    name: 'committed-motion-source',
    setup(builder) {
      builder.onResolve({ filter: /^baseline:/ }, (args) => ({
        path: args.path.slice('baseline:'.length), namespace: 'git-source',
      }));
      builder.onResolve({ filter: /.*/, namespace: 'git-source' }, (args) => {
        if (args.path.startsWith('@/')) return { path: `src/${args.path.slice(2)}`, namespace: 'git-source' };
        if (args.path.startsWith('.')) return {
          path: posix.normalize(posix.join(posix.dirname(args.importer), args.path)), namespace: 'git-source',
        };
        return { errors: [{ text: `Baseline unexpectedly imports an external package: ${args.path}` }] };
      });
      builder.onLoad({ filter: /.*/, namespace: 'git-source' }, (args) => {
        const candidates = args.path.endsWith('.ts') ? [args.path]
          : [`${args.path}.ts`, `${args.path}/index.ts`];
        for (const path of candidates) {
          let contents;
          try { contents = git('show', `${commit}:${path}`); } catch { continue; }
          return { contents, loader: 'ts' };
        }
        return { errors: [{ text: `No baseline source at ${commit}:${args.path}` }] };
      });
    },
  };
}

async function loadBundle(entryPoint, plugins = []) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entryPoint], bundle: true,
    platform: 'node', format: 'esm', write: false, plugins, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const [baseline, current, probe] = await Promise.all([
  loadBundle('baseline:src/interaction/motion-profile.ts', [baselinePlugin(baselineCommit)]),
  loadBundle('src/interaction/motion-profile.ts'),
  loadBundle('tests/interaction/motion-evidence.ts'),
]);

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

function measure(api, distancePx, targetWidthPx) {
  const from = { x: 100, y: 300 };
  const to = { x: from.x + distancePx, y: from.y };
  const eventCounts = new Set();
  const paths = new Set();
  const cadences = new Set();
  const durations = [];
  let maxPeakSpeedPxPerSecond = 0;
  let eventsAbove2400PxPerSecond = 0;
  let exactEndpoints = 0;
  let maxRoundingDriftMs = 0;
  for (let seed = 0; seed < samples; seed++) {
    const rng = probe.motionRng(seed);
    let points, delaysMs;
    if (api.movementPlan) {
      ({ points, delaysMs } = api.movementPlan(from, to, targetWidthPx, rng));
    } else {
      points = api.pathBetween(from, to, rng);
      const requestedMs = api.travelDurationMs(distancePx, targetWidthPx, rng);
      delaysMs = api.stepDelays(requestedMs, points.length - 1, rng);
      maxRoundingDriftMs = Math.max(maxRoundingDriftMs, Math.abs(sum(delaysMs) - requestedMs));
    }
    exactEndpoints += Number(points.at(-1).x === to.x && points.at(-1).y === to.y);
    eventCounts.add(delaysMs.length);
    paths.add(JSON.stringify(points));
    cadences.add(delaysMs.join(','));
    durations.push(sum(delaysMs));
    for (let i = 0; i < delaysMs.length; i++) {
      const speed = distance(points[i], points[i + 1]) * 1_000 / delaysMs[i];
      maxPeakSpeedPxPerSecond = Math.max(maxPeakSpeedPxPerSecond, speed);
      eventsAbove2400PxPerSecond += Number(speed > 2_400);
    }
  }
  durations.sort((a, b) => a - b);
  return {
    exactEndpoints, uniquePaths: paths.size, uniqueCadences: cadences.size,
    distinctEventCounts: eventCounts.size, maxPeakSpeedPxPerSecond, eventsAbove2400PxPerSecond,
    durationMs: { p10: percentile(durations, 0.1), median: percentile(durations, 0.5), p90: percentile(durations, 0.9) },
    legacyMaxDurationRoundingDriftMs: api.movementPlan ? null : maxRoundingDriftMs,
  };
}

function durationBoundary(api, distancePx) {
  const durations = Array.from({ length: samples }, (_, seed) =>
    api.travelDurationMs(distancePx, 40, probe.motionRng(seed))).sort((a, b) => a - b);
  return {
    distinctDurations: new Set(durations).size,
    at120msFloor: durations.filter((value) => value === 120).length,
    at1400msCeiling: durations.filter((value) => value === 1_400).length,
    medianMs: percentile(durations, 0.5),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  baselineCommit,
  workingTreeCommit: git('rev-parse', 'HEAD').trim(),
  runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
  sourceSha256: Object.fromEntries(await Promise.all([
    'src/interaction/motion-profile.ts', 'src/interaction/windmouse.ts',
    'src/interaction/motion-geometry.ts', 'src/interaction/motion-random.ts',
    'src/kernel/motion-policy.ts', 'tests/interaction/motion-evidence.ts',
    'scripts/motion-qc.mjs',
  ].map(async (path) => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')]))),
  samplesPerCase: samples,
  seedRange: [0, samples - 1],
  cases: [[100, 40], [700, 40], [2_000, 40], [2_000, 1_000]].map(([distancePx, targetWidthPx]) => ({
    distancePx, targetWidthPx,
    baseline: measure(baseline, distancePx, targetWidthPx),
    current: measure(current, distancePx, targetWidthPx),
  })),
  currentDistributions: [100, 700, 2_000].map((pixels) => probe.motionEvidence(pixels, samples)),
  durationBoundaries: [1, 30_000].map((distancePx) => ({
    distancePx, targetWidthPx: 40,
    baseline: durationBoundary(baseline, distancePx), current: durationBoundary(current, distancePx),
  })),
  limitations: [
    'Offline simulations, not browser event timings or an observational human movement dataset.',
    'The 2400 CSS px/s ceiling is a declared policy guardrail, not a measured human population bound.',
    'No claim of indistinguishability from human input or resistance to platform detection.',
  ],
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) {
  const output = resolve(values.out);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, json);
  console.error(`Motion QC report written to ${output}`);
}
process.stdout.write(json);
if (report.cases.some(({ current }) => current.exactEndpoints !== samples
  || current.eventsAbove2400PxPerSecond !== 0 || !Number.isFinite(current.maxPeakSpeedPxPerSecond))) {
  console.error('Current motion failed an endpoint or velocity invariant; inspect the report.');
  process.exitCode = 1;
}
