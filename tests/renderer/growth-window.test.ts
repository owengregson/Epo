import { computeGrowthOverlay } from '@/renderer/charts/growth-overlay';
import {
  computeMomentum,
  GROWTH_WINDOW_FALLBACK_DAYS,
  hasMeasuredSignal,
  overlayHorizonDays,
  startOfLocalDay,
  windowDays,
} from '@/renderer/charts/growth-window';
import { MS_PER_DAY } from '@/timing/units';
import { CONVERSION_VERDICT_MIN, type NetGrowthPoint } from '@/types';

/** `k` days before now, same time of day (Date arithmetic — DST-safe). */
function daysAgo(k: number, from = Date.now()): number {
  const d = new Date(from);
  d.setDate(d.getDate() - k);
  return d.getTime();
}

/** A cumulative-net series ending today, one point per day (store shape). */
function series(nets: number[]): NetGrowthPoint[] {
  const today = startOfLocalDay(Date.now());
  return nets.map((cumulativeNet, i) => ({
    dayStartMs: today - (nets.length - 1 - i) * MS_PER_DAY,
    cumulativeNet,
  }));
}

describe('windowDays', () => {
  const now = Date.now();

  it('maps the fixed windows to their literal spans', () => {
    expect(windowDays('14d', null, now)).toBe(14);
    expect(windowDays('30d', daysAgo(400), now)).toBe(30);
    expect(windowDays('90d', null, now)).toBe(90);
  });

  it('spans "all" from the baseline day through today, inclusive', () => {
    expect(windowDays('all', daysAgo(6), now)).toBe(7);
    expect(windowDays('all', daysAgo(89), now)).toBe(90);
    // Baseline stamped today → a single measured day, never a padded window.
    expect(windowDays('all', now, now)).toBe(1);
  });

  it('falls back to the default span for "all" before measurement began', () => {
    expect(windowDays('all', null, now)).toBe(GROWTH_WINDOW_FALLBACK_DAYS);
  });
});

describe('hasMeasuredSignal', () => {
  it('is false for an all-zero series and true for any nonzero net day', () => {
    expect(hasMeasuredSignal(series([0, 0, 0, 0]))).toBe(false);
    expect(hasMeasuredSignal(series([0, 0, -2, 0]))).toBe(true);
    expect(hasMeasuredSignal([])).toBe(false);
  });
});

describe('computeMomentum', () => {
  it('gates below four points — a half must span at least two days', () => {
    const pts = series([0, 3, 5]);
    expect(computeMomentum(pts, daysAgo(30)).ready).toBe(false);
  });

  it('gates before any measurement baseline exists', () => {
    expect(computeMomentum(series([0, 0, 1, 2, 3, 4]), null).ready).toBe(false);
  });

  it('gates when the baseline does not cover the window start', () => {
    const pts = series([0, 0, 0, 1, 2, 3]);
    // Measurement began mid-window: the prior half is silence, not zeros.
    const baselineAt = pts[0].dayStartMs + 2.5 * MS_PER_DAY;
    expect(computeMomentum(pts, baselineAt).ready).toBe(false);
  });

  it('gates on an all-zero series — no recorded events, no "+0" verdict', () => {
    const pts = series([0, 0, 0, 0, 0, 0]);
    expect(computeMomentum(pts, daysAgo(30)).ready).toBe(false);
  });

  it('reads recent-half minus prior-half once covered and nonzero', () => {
    const pts = series([0, 1, 1, 2, 4, 7]);
    const m = computeMomentum(pts, daysAgo(30));
    expect(m.ready).toBe(true);
    // mid=3: prior = 2-0 = 2, recent = 7-2 = 5 → delta 3, halves of 3 days.
    expect(m.delta).toBe(3);
    expect(m.halfDays).toBe(3);
  });

  it('accepts a baseline stamped mid-day on the window: start day counts as covered', () => {
    const pts = series([0, 2, 3, 4]);
    const m = computeMomentum(pts, pts[0].dayStartMs + 1000);
    expect(m.ready).toBe(true);
  });
});

describe('overlayHorizonDays', () => {
  it('projects half the window, clamped to [7, 30]', () => {
    expect(overlayHorizonDays(14)).toBe(7);
    expect(overlayHorizonDays(30)).toBe(15);
    expect(overlayHorizonDays(90)).toBe(30);
    expect(overlayHorizonDays(365)).toBe(30);
    expect(overlayHorizonDays(6)).toBe(7);
    expect(overlayHorizonDays(0)).toBe(7);
  });
});

describe('computeGrowthOverlay', () => {
  const base = {
    rate: 55,
    privateBoost: 0.15,
    bandWidth: 0.6,
    waitDays: 4,
    holdDays: 2,
    horizonDays: 10,
    realizedEnd: 37,
    sample: null,
  };

  it('re-anchors every path exactly at the realized endpoint', () => {
    const o = computeGrowthOverlay(base);
    expect(o.cautious[0]).toBe(37);
    expect(o.expected[0]).toBe(37);
    expect(o.optimistic[0]).toBe(37);
    // Negative realized nets anchor too — churn-heavy accounts stay honest.
    const neg = computeGrowthOverlay({ ...base, realizedEnd: -5 });
    expect(neg.expected[0]).toBe(-5);
  });

  it('emits one point per day 0..horizon, never dipping below the anchor', () => {
    const o = computeGrowthOverlay(base);
    for (const path of [o.cautious, o.expected, o.optimistic]) {
      expect(path).toHaveLength(base.horizonDays + 1);
      for (const v of path) expect(v).toBeGreaterThanOrEqual(base.realizedEnd);
    }
  });

  it('orders the fan cautious ≤ expected ≤ optimistic at the horizon', () => {
    const o = computeGrowthOverlay(base);
    const last = base.horizonDays;
    expect(o.cautious[last]).toBeLessThanOrEqual(o.expected[last]);
    expect(o.expected[last]).toBeLessThanOrEqual(o.optimistic[last]);
  });

  it('keeps the settings-derived yield below the sample gate', () => {
    const small = computeGrowthOverlay({
      ...base,
      sample: { followedBack: 3, total: CONVERSION_VERDICT_MIN - 1 },
    });
    expect(small.measuredYield).toBe(false);
    const none = computeGrowthOverlay(base);
    expect(none.measuredYield).toBe(false);
    expect(small.expectedP).toBeCloseTo(none.expectedP, 10);
  });

  it('centers the expected path on the measured rate once the sample clears the gate', () => {
    const o = computeGrowthOverlay({ ...base, sample: { followedBack: 25, total: 100 } });
    expect(o.measuredYield).toBe(true);
    expect(o.expectedP).toBeCloseTo(0.25, 10);
    // A stronger measured yield grows the expected endpoint.
    const weak = computeGrowthOverlay({ ...base, sample: { followedBack: 10, total: 100 } });
    expect(o.expected[base.horizonDays]).toBeGreaterThan(weak.expected[base.horizonDays]);
  });
});
