import type { CircadianProfile } from '@/timing/circadian';
import { intensityAt } from '@/timing/circadian';
import { jittered } from '@/timing/primitives';
import { sample } from '@/timing/primitives';
import {
  SessionPlanner,
  type SessionPlannerConfig,
} from '@/timing/session-planner';

/**
 * The acceptance test for "the timeline looks like organic data" (plan §8): drive the
 * real SessionPlanner across a simulated month and assert the emitted action timeline is
 * bimodal-log-normal, circadian, velocity-safe, and — crucially — HIGHER ENTROPY and less
 * regular than the legacy flat metronome (the signature bot detectors key on).
 */

const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const PROFILE: CircadianProfile = {
  bumps: [
    { centerHour: 8.0, amplitude: 0.45, widthHours: 1.6 },
    { centerHour: 13.0, amplitude: 0.5, widthHours: 2.0 },
    { centerHour: 18.0, amplitude: 1.0, widthHours: 3.0 },
  ],
  overnightFloor: 0.015,
  dayOfWeekWeights: [0.9, 1.0, 1.08, 1.08, 1.0, 1.02, 0.92],
  weekendShiftHours: 1.4,
  phaseOffsetHours: 0,
};

const CFG: SessionPlannerConfig = {
  dailyMeanActions: 25,
  dailyHardCeiling: 40,
  dayVolumeSigma: 0.28,
  restDayProbability: 0.08,
  restDayMaxFraction: 0.15,
  sessionsPerDayMin: 3,
  sessionsPerDayMax: 6,
  gapMedianMs: 95_000,
  gapSigma: 0.75,
  gapFloorMs: 45_000,
  gapCapMs: 8 * 60_000,
  hawkesAlpha: 0.35,
  hawkesTauMs: 90_000,
  maxActionsPerRollingHour: 22,
};

const DAYS = 30;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const START = new Date(2026, 0, 4, 0, 0).getTime(); // Sunday midnight

/** Drive the planner: act while a session is open, jump to the next session otherwise. */
function simulateOrganic(seed: number): number[] {
  const p = new SessionPlanner({ rng: mulberry32(seed), profile: PROFILE, cfg: CFG });
  const events: number[] = [];
  const end = START + DAYS * MS_PER_DAY;
  let t = START;
  let guard = 0;
  while (t < end && guard < 2_000_000) {
    guard += 1;
    p.advance(t);
    if (p.isSessionOpen(t)) {
      p.recordAction(t, 'follow');
      events.push(t);
      t += p.nextActionGapMs(t);
    } else {
      const next = p.nextSessionStartAt(t);
      t = next > t ? next : t + 60_000;
    }
  }
  return events;
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

describe('macro-pattern — organic timeline over 30 simulated days', () => {
  const events = simulateOrganic(2026);
  const gaps = diffs(events);
  const legacyEvents = simulateLegacy(2026);
  const legacyGaps = diffs(legacyEvents);

  test('delivers ~the configured daily mean on average (distributed, not exactly 25×30)', () => {
    const perDayMean = events.length / DAYS;
    // Realized mean tracks the configured mean (25) within ~15% after rest days.
    expect(perDayMean).toBeGreaterThan(25 * 0.85);
    expect(perDayMean).toBeLessThan(25 * 1.15);
  });

  test('inter-event gaps are bimodal: a within-session cluster AND a between-session cluster', () => {
    const withinShare = gaps.filter((g) => g < 5 * 60_000).length / gaps.length;
    const betweenShare = gaps.filter((g) => g > 30 * 60_000).length / gaps.length;
    expect(withinShare).toBeGreaterThan(0.15);
    expect(betweenShare).toBeGreaterThan(0.1);
  });

  test('the gap distribution is heavy-tailed (a few gaps ≫ the median)', () => {
    const m = median(gaps);
    expect(gaps.some((g) => g > 10 * m)).toBe(true);
  });

  test('actions track the circadian curve and avoid the small hours', () => {
    const hourCounts = new Array(24).fill(0);
    for (const e of events) hourCounts[new Date(e).getHours()] += 1;
    const anchor = new Date(2026, 0, 5, 0, 30).getTime();
    const intens = Array.from({ length: 24 }, (_, h) => intensityAt(anchor + h * MS_PER_HOUR, PROFILE));
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
    const perDay = new Map<string, number>();
    for (const e of events) {
      const d = new Date(e);
      const k = `${d.getMonth()}-${d.getDate()}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const counts = [...perDay.values()];
    expect(cv(counts)).toBeGreaterThan(0.15);
    expect(counts.some((c) => c < 25 * 0.4)).toBe(true); // some quiet days
  });

  test('velocity safety: never exceeds the rolling-hour cap, never below the floor', () => {
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(CFG.gapFloorMs);
    let maxInHour = 0;
    for (let i = 0; i < events.length; i++) {
      let n = 0;
      for (let j = i; j >= 0 && events[i] - events[j] < MS_PER_HOUR; j--) n++;
      maxInHour = Math.max(maxInHour, n);
    }
    expect(maxInHour).toBeLessThanOrEqual(CFG.maxActionsPerRollingHour);
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
