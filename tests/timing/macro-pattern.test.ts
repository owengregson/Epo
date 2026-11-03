import { PlanService } from '@/governors/plan-service';
import { intensityAt } from '@/kernel/plan/circadian';
import { automaticDayMax } from '@/kernel/plan/volume';
import { createMutationCadence } from '@/main/services/mutation-cadence';
import { NOISE } from '@/timing/config';
import { boundarySeedKey, cadenceFactor, jitterBoundary } from '@/timing/noise';
import { jittered, sample } from '@/timing/primitives';
import { memoryPlanStore, planDeps, testIntent } from '../kit/plan';

/**
 * The acceptance test for "the timeline looks like organic data" (plan §8): drive the
 * real plan service across a simulated month — act while a session is open and the day's
 * volume remains, then wait the plan's reference gap — and assert the emitted timeline is
 * bimodal-log-normal, circadian, velocity-safe, inside the day law, and less regular than
 * the legacy flat metronome.
 */

const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const INTENT = testIntent();
const DAYS = 30;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const START = new Date(2026, 0, 4, 0, 0).getTime(); // Sunday midnight

/** Drive the plan: act while a session is open and volume remains, jump to the next session otherwise. */
function simulatePlan(seed: number): { events: number[]; days: Map<string, number>; phase: number } {
  const store = memoryPlanStore();
  const clock = { t: START };
  const plan = new PlanService(planDeps(store, clock, { intent: () => INTENT, installEntropy: seed }));
  // The production draw: the cadence arms the session's gap at each dispatch (no deadline store here).
  const cadence = createMutationCadence({ plan, store: { getActionDelayDeadline: () => null,
    setActionDelayDeadline: () => undefined, recentMutationTimes: (since) => store.recentMutationTimes(since) } });
  const events: number[] = [];
  const days = new Map<string, number>();
  const end = START + DAYS * MS_PER_DAY;
  let t = START;
  for (let guard = 0; t < end && guard < 200_000; guard += 1) {
    clock.t = t;
    const view = plan.ensure(t);
    const admission = cadence.preflight('follow', 'growth', t);
    if (view.open !== null && admission.ok) {
      const deadline = cadence.armAtDispatch('follow', 'growth', t);
      store.mutations.push({ at: t, kind: 'follow', auto: true });
      events.push(t);
      days.set(view.window.key, (days.get(view.window.key) ?? 0) + 1);
      t = deadline;
    } else if (!admission.ok && admission.until !== null && admission.until > t && view.open !== null) {
      t = admission.until;
    } else {
      const next = view.nextSessionAt ?? view.window.endsAt;
      t = next > t ? next : t + 60_000;
    }
  }
  return { events, days, phase: plan.snapshot(START).state.phaseOffsetHours };
}

/** The legacy metronome for comparison: jittered 3–7 min within 8:00–22:00, 25/day. */
function simulateLegacy(seed: number): number[] {
  const rng = mulberry32(seed);
  const events: number[] = [];
  const end = START + DAYS * MS_PER_DAY;
  const perDay = new Map<string, number>();
  const key = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getMonth()}-${d.getDate()}`;
  };
  const nextEight = (ms: number): number => {
    const d = new Date(ms);
    if (d.getHours() >= 8) d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.getTime();
  };
  let t = START;
  let guard = 0;
  while (t < end && guard < 2_000_000) {
    guard += 1;
    const d = new Date(t);
    const k = key(t);
    const count = perDay.get(k) ?? 0;
    if (d.getHours() < 8 || d.getHours() >= 22 || count >= 25) {
      t = nextEight(t);
      continue;
    }
    events.push(t);
    perDay.set(k, count + 1);
    t += sample(jittered(180_000, 420_000, 30), rng);
  }
  return events;
}

const diffs = (xs: number[]): number[] => xs.slice(1).map((x, i) => x - xs[i]);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const cv = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2))) / mean(xs);

/** Shannon entropy (nats) of gaps binned on a log scale 30s → 24h. */
function gapEntropy(gaps: number[]): number {
  const lo = Math.log(30_000);
  const hi = Math.log(MS_PER_DAY);
  const B = 24;
  const bins = new Array(B).fill(0);
  for (const g of gaps) {
    const clamped = Math.min(MS_PER_DAY, Math.max(30_000, g));
    const idx = Math.min(B - 1, Math.floor(((Math.log(clamped) - lo) / (hi - lo)) * B));
    bins[idx] += 1;
  }
  let h = 0;
  for (const c of bins) {
    if (c === 0) continue;
    const p = c / gaps.length;
    h -= p * Math.log(p);
  }
  return h;
}

describe("macro-pattern — the plan's timeline over 30 simulated days", () => {
  const { events, days, phase } = simulatePlan(2026);
  const gaps = diffs(events);
  const legacyEvents = simulateLegacy(2026);
  const legacyGaps = diffs(legacyEvents);
  const P0 = INTENT.operatingRate;

  test("delivers the day law's mean (a draw under the target), never a day above the automatic maximum", () => {
    const perDayMean = events.length / DAYS;
    expect(perDayMean).toBeGreaterThan(P0 * 0.6);
    expect(perDayMean).toBeLessThan(P0 * 0.95);
    expect(Math.max(...days.values())).toBeLessThanOrEqual(automaticDayMax(P0));
  });

  test('inter-event gaps are bimodal: a within-session cluster AND a between-session cluster', () => {
    const withinShare = gaps.filter((g) => g < 5 * 60_000).length / gaps.length;
    const betweenShare = gaps.filter((g) => g > 30 * 60_000).length / gaps.length;
    expect(withinShare).toBeGreaterThan(0.5);
    expect(betweenShare).toBeGreaterThan(0.08);
  });

  test('the gap distribution is heavy-tailed (a few gaps ≫ the median)', () => {
    const m = median(gaps);
    expect(gaps.some((g) => g > 10 * m)).toBe(true);
  });

  test('actions track the circadian curve and avoid the small hours', () => {
    const hourCounts = new Array(24).fill(0);
    for (const e of events) hourCounts[new Date(e).getHours()] += 1;
    const anchor = new Date(2026, 0, 5, 0, 30).getTime();
    const intens = Array.from({ length: 24 }, (_, h) => intensityAt(anchor + h * MS_PER_HOUR, INTENT.shape, phase));
    const mc = mean(hourCounts);
    const mi = mean(intens);
    let num = 0;
    let dc = 0;
    let di = 0;
    for (let h = 0; h < 24; h++) {
      num += (hourCounts[h] - mc) * (intens[h] - mi);
      dc += (hourCounts[h] - mc) ** 2;
      di += (intens[h] - mi) ** 2;
    }
    expect(num / Math.sqrt(dc * di)).toBeGreaterThan(0.55);
    const nightShare = (hourCounts[3] + hourCounts[4]) / events.length;
    expect(nightShare).toBeLessThan(0.03);
  });

  test('daily volume genuinely varies day to day', () => {
    const counts = [...days.values()];
    expect(cv(counts)).toBeGreaterThan(0.15);
    expect(counts.some((c) => c < P0 * 0.4)).toBe(true); // some light days
  });

  test('velocity safety: never exceeds the rolling-hour cap, never below the floor', () => {
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(INTENT.gap.floorMs);
    let maxInHour = 0;
    for (let i = 0; i < events.length; i++) {
      let n = 0;
      for (let j = i; j >= 0 && events[i] - events[j] < MS_PER_HOUR; j--) n++;
      maxInHour = Math.max(maxInHour, n);
    }
    expect(maxInHour).toBeLessThanOrEqual(INTENT.hourlyCap);
  });

  test('anti-regularity: higher gap entropy and less fixed-timer regularity than the legacy metronome', () => {
    expect(gapEntropy(gaps)).toBeGreaterThan(gapEntropy(legacyGaps));
    expect(gapEntropy(gaps)).toBeGreaterThan(1.5);
    // Within-session gaps: log-normal spread (high CV) vs the legacy uniform±jitter (low CV).
    const within = gaps.filter((g) => g < 30 * 60_000);
    const legacyWithin = legacyGaps.filter((g) => g < 30 * 60_000);
    expect(cv(within)).toBeGreaterThan(cv(legacyWithin));
    expect(cv(within)).toBeGreaterThan(0.4);
  });
});

/**
 * The LEGACY path's timing-noise (deterministic-scheduling fix): the shipped
 * default model is the legacy metronome, so its macro cadence must carry
 * entropy DIRECTLY — daily wake instants and sweep intervals over a simulated
 * week must vary, never repeat to the second.
 */
describe('macro-pattern — legacy-path timing noise over a simulated week', () => {
  const variance = (xs: number[]): number => mean(xs.map((x) => (x - mean(xs)) ** 2));

  test('daily wake instants vary day to day and never land exactly on the o’clock', () => {
    const entropy = 0xc0ffee;
    const offsets: number[] = [];
    for (let day = 0; day < 7; day += 1) {
      const boundary = new Date(2026, 0, 5 + day, 8, 0, 0, 0).getTime(); // 08:00 local
      const parkedFrom = boundary - 10 * MS_PER_HOUR; // engine parked at 22:00 the evening before
      const base = boundary - parkedFrom;
      const wake =
        parkedFrom +
        jitterBoundary(base, boundarySeedKey(boundary, 'engine:active-hours-park'), entropy);
      const offset = wake - boundary;
      expect(offset).toBeGreaterThan(0); // never before (or exactly on) the window open
      expect(offset).toBeLessThanOrEqual(NOISE.DAILY_BOUNDARY_JITTER_MAX_MS);
      offsets.push(offset);
    }
    expect(variance(offsets)).toBeGreaterThan(0); // wake instants genuinely differ per day
  });

  test('sweep intervals vary run to run within the cadence band', () => {
    const rng = mulberry32(99);
    const intervals = Array.from({ length: 24 }, () => MS_PER_HOUR * cadenceFactor(rng));
    for (const iv of intervals) {
      expect(iv).toBeGreaterThanOrEqual(MS_PER_HOUR * NOISE.CADENCE_MIN_FACTOR);
      expect(iv).toBeLessThanOrEqual(MS_PER_HOUR * NOISE.CADENCE_MAX_FACTOR);
    }
    expect(variance(intervals)).toBeGreaterThan(0); // no bare hourly grid
  });
});
