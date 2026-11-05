/**
 * Tier 0 hygiene. A belief with no source is a magic number wearing a coat, and
 * a belief nobody has looked at in a year is worse than one you know is a guess
 * — so both are build failures, not review comments.
 */

import { EMPIRICAL, empiricalProvenance } from '@/kernel/fundamentals';
import { BOUNDS, PACING_BASE_MS, POLICY, PREFERENCES, SCALES } from '@/kernel/policy';

/**
 * FIXED review date, deliberately not `Date.now()`: a test that goes red on its
 * own after twelve months of wall-clock is a time bomb, not a signal. Bump this
 * when you re-review the fundamentals, and the freshness window moves with you.
 */
const REVIEWED_ON = '2026-09';
const MAX_AGE_MONTHS = 12;

/** `YYYY-MM` → months since year 0, so the comparison is plain arithmetic. */
function monthIndex(rev: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(rev);
  if (m === null) throw new Error(`rev must be YYYY-MM, got "${rev}"`);
  return Number(m[1]) * 12 + Number(m[2]);
}

describe('EMPIRICAL — provenance', () => {
  const entries = empiricalProvenance();

  test('the walk finds every belief (and each is reached exactly once)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
    expect(new Set(entries.map((e) => e.path)).size).toBe(entries.length);
  });

  test('every entry carries a real source, not a placeholder', () => {
    for (const e of entries) {
      expect(`${e.path}: ${e.src}`.length).toBeGreaterThan(e.path.length + 20);
      expect(e.src).not.toMatch(/^(tbd|todo|\?+)$/i);
    }
  });

  test('no belief is more than 12 months stale', () => {
    const cutoff = monthIndex(REVIEWED_ON) - MAX_AGE_MONTHS;
    const stale = entries.filter((e) => monthIndex(e.rev) < cutoff).map((e) => e.path);
    expect(stale).toEqual([]);
  });

  test('no belief claims to have been reviewed in the future', () => {
    const now = monthIndex(REVIEWED_ON);
    expect(entries.filter((e) => monthIndex(e.rev) > now).map((e) => e.path)).toEqual([]);
  });
});

describe('EMPIRICAL — shape', () => {
  test('every wall band is positive and ordered low ≤ typical', () => {
    for (const w of [
      EMPIRICAL.FOLLOW_WALL_PER_HOUR,
      EMPIRICAL.FOLLOW_WALL_PER_DAY,
      EMPIRICAL.UNFOLLOW_WALL_PER_HOUR,
    ]) {
      expect(w.low).toBeGreaterThan(0);
      expect(w.low).toBeLessThanOrEqual(w.typical);
    }
  });

  test('the soft wall p50 is below its p90', () => {
    expect(EMPIRICAL.SOFT_WALL_DURATION_H.p50).toBeLessThan(EMPIRICAL.SOFT_WALL_DURATION_H.p90);
  });

  test('every latency seed has ordered percentiles', () => {
    for (const [op, l] of Object.entries(EMPIRICAL.LATENCY)) {
      expect(`${op}:${l.p50 > 0}`).toBe(`${op}:true`);
      expect(l.p50).toBeLessThan(l.p99);
      if ('p95' in l && typeof l.p95 === 'number') {
        expect(l.p50).toBeLessThanOrEqual(l.p95);
        expect(l.p95).toBeLessThanOrEqual(l.p99);
      }
    }
  });

  test('every rate is a probability', () => {
    for (const r of [
      EMPIRICAL.ORDINARY_FAIL_RATE,
      EMPIRICAL.ORDINARY_BLOCK_RATE,
      EMPIRICAL.ORDINARY_DRIFT_SIGNAL_RATE,
      EMPIRICAL.ORDINARY_DUPLICATE_PAGE_RATE,
      EMPIRICAL.HUMAN_REST_DAY_RATE,
    ]) {
      expect(r.value).toBeGreaterThan(0);
      expect(r.value).toBeLessThan(1);
    }
  });

  test('the Hawkes kernel stays sub-critical (a self-exciting burst winds down)', () => {
    expect(EMPIRICAL.HUMAN_BURST.alpha).toBeGreaterThan(0);
    expect(EMPIRICAL.HUMAN_BURST.alpha).toBeLessThan(1);
  });

  test('the circadian shape is a 7-day week with a non-zero overnight floor', () => {
    expect(EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek).toHaveLength(7);
    expect(EMPIRICAL.HUMAN_CIRCADIAN.overnightFloor).toBeGreaterThan(0);
    for (const b of EMPIRICAL.HUMAN_CIRCADIAN.bumps) {
      expect(b.centerHour).toBeGreaterThanOrEqual(0);
      expect(b.centerHour).toBeLessThan(24);
      expect(b.widthHours).toBeGreaterThan(0);
    }
  });
});

describe('POLICY — the dials stay dials', () => {
  test('the five arguable numbers are in sane ranges', () => {
    expect(POLICY.SAFETY_MARGIN).toBeGreaterThan(0);
    expect(POLICY.SAFETY_MARGIN).toBeLessThan(1);
    expect(POLICY.BURST_TOLERANCE).toBeGreaterThan(1);
    expect(POLICY.TIMEOUT_SLACK).toBeGreaterThan(1);
    expect(POLICY.CONFIDENCE).toBeGreaterThan(0.5);
    expect(POLICY.CONFIDENCE).toBeLessThan(1);
    expect(POLICY.DESYNC_WIDTH_MS).toBeGreaterThan(0);
  });

  test('every prior is a probability, and probing after a hold is the most suspicious', () => {
    const { cold, afterHold, signalled } = POLICY.PRIOR_SYSTEMIC;
    for (const p of [cold, afterHold, signalled]) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
    expect(cold).toBeLessThan(signalled);
    expect(signalled).toBeLessThan(afterHold);
  });

  test('every ordinal scale is strictly increasing (or decreasing) across its levels', () => {
    const rising = (o: Record<string, number>) => Object.values(o);
    expect(rising(SCALES.caution)).toEqual([...rising(SCALES.caution)].sort((a, b) => a - b));
    expect(rising(SCALES.activity)).toEqual([...rising(SCALES.activity)].sort((a, b) => a - b));
    expect(rising(SCALES.consistency)).toEqual([...rising(SCALES.consistency)].sort((a, b) => a - b));
    expect(rising(SCALES.restDay)).toEqual([...rising(SCALES.restDay)].sort((a, b) => a - b));
    // rhythm is the one that runs the other way: trickle has the longest gaps.
    expect(rising(SCALES.rhythm)).toEqual([...rising(SCALES.rhythm)].sort((a, b) => b - a));
    // `standard` / `sessions` / `natural` are the identity rung: the empirical
    // value itself, unscaled. That is what makes `balanced` the human baseline.
    expect(SCALES.caution.standard).toBe(1);
    expect(SCALES.rhythm.sessions).toBe(1);
    expect(SCALES.consistency.natural).toBe(1);
    expect(SCALES.restDay.natural).toBe(1);
  });

  test('each session-per-day window is ordered and inside [0,1] of the human range', () => {
    for (const [lo, hi] of Object.values(SCALES.sessionsWindow)) {
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo).toBeLessThanOrEqual(hi);
      expect(hi).toBeLessThanOrEqual(1);
    }
  });

  test('every pacing base is positive, and the band never crosses zero', () => {
    expect(POLICY.BAND_HALF_WIDTH).toBeGreaterThan(0);
    expect(POLICY.BAND_HALF_WIDTH).toBeLessThan(1);
    for (const base of Object.values(PACING_BASE_MS)) expect(base).toBeGreaterThan(0);
  });

  test('every bound is a positive number (a guardrail, never a disabled one)', () => {
    for (const group of Object.values(BOUNDS)) {
      for (const [key, v] of Object.entries(group)) {
        expect(`${key}:${typeof v}`).toBe(`${key}:number`);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  test('preference tables cover their levels and stay ordered', () => {
    const fractions = Object.values(PREFERENCES.cleanup).map((c) => c.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    const waits = Object.values(PREFERENCES.patience).map((p) => p.waitDays);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
    for (const p of Object.values(PREFERENCES.patience)) {
      expect(p.holdDays).toBeLessThanOrEqual(p.waitDays);
    }
    expect(Object.keys(PREFERENCES.dayShape)).toHaveLength(4); // `balanced` derives
    expect(Object.keys(PREFERENCES.weeklyShape)).toHaveLength(3); // `realistic` derives
    for (const w of Object.values(PREFERENCES.weeklyShape)) expect(w).toHaveLength(7);
  });
});
