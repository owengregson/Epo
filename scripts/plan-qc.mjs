/**
 * Offline, seeded envelope audit of the day plan (ADR 0607, spec §20.4): 28 plan-days per persona ×
 * consistency × caution, drawn from the real kernel through the live-settings bridge. Exits non-zero
 * on any envelope breach or any automatic day above automaticDayMax(P0). No Electron, no network.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const DAYS = 28;
const DAY_MS = 86_400_000;
const START = new Date(2026, 10, 3, 12).getTime();

async function loadPlan() {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { drawDayPlan } from './src/kernel/plan/draw';
        export { automaticDayMax } from './src/kernel/plan/volume';
        export { planDayWindow, quietMinute, inQuietHours, localMinuteOf } from './src/kernel/plan/circadian';
        export { phaseOffsetHours } from './src/kernel/plan/seed';
        export { gapCapMax } from './src/kernel/plan/gap';
        export { planReadAllowance } from './src/kernel/plan/reads';
        export { EMPIRICAL } from './src/kernel/fundamentals';
        export { POLICY } from './src/kernel/policy';
        export { toPlanIntent } from './src/settings/plan-intent';
        export { effectiveFromV1 } from './src/settings/effective';
        export { PERSONAS, resolvePattern } from './src/settings/pattern-map';
        export { DEFAULT_SETTINGS } from './src/settings/settings';`,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'error',
  });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(module, module.exports, require);
  return module.exports;
}

/** Every envelope breach of one drawn plan-day, as text. */
function breaches(k, intent, demandless, plan) {
  const out = [];
  const say = (what) => out.push(`${plan.window.key}: ${what}`);
  const boundary = k.EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;
  const planned = plan.sessions.reduce((a, s) => a + s.budget, 0);
  if (planned > k.automaticDayMax(intent.operatingRate)) say(`automatic day ${planned} > automaticDayMax ${k.automaticDayMax(intent.operatingRate)}`);
  if (planned !== plan.volume.planned) say(`Σ budgets ${planned} ≠ planned ${plan.volume.planned}`);
  if (plan.kinds.follow > intent.operatingRate) say(`follows ${plan.kinds.follow} > P0 ${intent.operatingRate}`);
  if (plan.kinds.unfollow > Math.floor(plan.volume.drawn / 2)) say(`unfollows ${plan.kinds.unfollow} > ⌊V/2⌋`);
  plan.sessions.forEach((s, i) => {
    const prev = plan.sessions[i - 1];
    if (s.startAt < plan.window.startsAt || s.expectedEndAt > plan.window.endsAt + 1) say(`session ${i} outside the window`);
    if (prev && s.startAt < prev.expectedEndAt + boundary - 1) say(`sessions ${i - 1}/${i} closer than the boundary`);
    if (s.mix.follow + s.mix.unfollow + s.mix.accept > s.budget) say(`session ${i} kinds exceed its budget`);
    if (s.tempo.pace < 0.7 || s.tempo.pace > 1.45) say(`session ${i} pace ${s.tempo.pace} outside the beat band`);
    if (s.tempo.gap.timeScale < 1) say(`session ${i} τ < 1`);
    if (s.tempo.gap.capMs > k.gapCapMax()) say(`session ${i} gap cap past CAP_MAX`);
    const hour = s.tempo.probation ? intent.probationHourlyCap : intent.hourlyCap;
    if (s.tempo.gap.targetMeanMs < (3_600_000 * k.POLICY.CEILING_HEADROOM) / hour - 1e-6) say(`session ${i} target gap faster than H/1.3`);
    for (let t = s.startAt; t < s.expectedEndAt; t += 5 * 60_000) {
      if (k.inQuietHours(k.localMinuteOf(t), intent.quietHours)) { say(`session ${i} inside quiet hours`); break; }
    }
  });
  const d6 = k.planReadAllowance(intent, demandless);
  const r = plan.reads;
  if (r.explorePages + r.census + r.following + r.checkPages + r.catchUp.pages > d6.listPages) say('pages past D6');
  if (r.explore + r.reconcile + r.catchUp.profiles > d6.profiles) say('profiles past D6');
  if (r.checks + r.catchUp.notifications > d6.notifications) say('checks past D6');
  return out;
}

const k = await loadPlan();
const demand = {
  lifecycleDueByDayEnd: 6, lifecycleBacklog: 0, pruneStock: 40, protectedReeval: 2, journalPending: 1, followsDoneToday: 0,
  outsideToday: 0, pendingRequests: 2, acceptsRecent: 1.5, ownHeader: { followers: null, following: null },
  census: { lastCompleteAt: null, rowsPerPage: null },
};
const failures = [];
let days = 0;
let maxShare = 0;
for (const [persona, base] of Object.entries(k.PERSONAS)) {
  for (const consistency of ['clockwork', 'natural', 'erratic']) {
    for (const caution of ['cautious', 'standard', 'bold']) {
      const pattern = { ...base, consistency, caution, cleanup: 'steady' };
      const intent = k.toPlanIntent(k.effectiveFromV1({ ...k.DEFAULT_SETTINGS, pattern, ...k.resolvePattern(pattern) }));
      const entropy = 0x5eed ^ (days * 2654435761);
      const phase = k.phaseOffsetHours(entropy);
      const qm = k.quietMinute(intent.shape, phase, intent.quietHours);
      let window = k.planDayWindow(START, qm);
      for (let d = 0; d < DAYS; d += 1) {
        const plan = k.drawDayPlan({ installEntropy: entropy, window, intent, demand, phaseOffsetHours: phase,
          firstOpenAt: window.startsAt, boost: null, runIntent: 'running' });
        for (const b of breaches(k, intent, demand, plan)) failures.push(`${persona}/${consistency}/${caution} ${b}`);
        maxShare = Math.max(maxShare, plan.volume.planned / k.automaticDayMax(intent.operatingRate));
        days += 1;
        window = k.planDayWindow(window.endsAt, qm);
      }
    }
  }
}
console.log(`plan-qc: ${days} plan-days drawn; largest day at ${(maxShare * 100).toFixed(1)} % of automaticDayMax; ${failures.length} breach(es)`);
for (const f of failures.slice(0, 40)) console.log(`  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
