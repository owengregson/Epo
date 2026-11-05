/**
 * The reopen kit: plan-day windows that tile time, and generated growth histories (header
 * observations, dated follower changes, Epo's writes) for the accounting laws. Pure data.
 */

import fc from 'fast-check';
import type { ChangeSource, DayWindow, EpoWrite, FollowerChange, OwnHeader, WindowOf } from '@/store/folds/growth';

const HOUR = 3_600_000;

/** Plan-day windows from sorted boundaries; times outside the list extend the first or last length. */
export function windowsFrom(boundaries: readonly number[]): WindowOf {
  const b = [...boundaries].sort((x, y) => x - y);
  return (t: number): DayWindow => {
    if (t < b[0]) {
      const len = b[1] - b[0];
      const k = Math.ceil((b[0] - t) / len);
      return { startsAt: b[0] - k * len, endsAt: b[0] - (k - 1) * len };
    }
    const last = b.length - 1;
    if (t >= b[last]) {
      const len = b[last] - b[last - 1];
      const k = Math.floor((t - b[last]) / len);
      return { startsAt: b[last] + k * len, endsAt: b[last] + (k + 1) * len };
    }
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid] <= t) lo = mid;
      else hi = mid;
    }
    return { startsAt: b[lo], endsAt: b[lo + 1] };
  };
}

/** Every window [startsAt, endsAt) from `windowOf` that meets [from, to]. */
export function windowsCovering(windowOf: WindowOf, from: number, to: number): DayWindow[] {
  const out: DayWindow[] = [];
  for (let w = windowOf(from); w.startsAt <= to; w = windowOf(w.endsAt)) out.push(w);
  return out;
}

/** A generated history: headers, changes inside the header span, and plan-day boundaries. */
export interface GrowthHistory {
  readonly headers: readonly OwnHeader[];
  readonly changes: readonly FollowerChange[];
  readonly windowOf: WindowOf;
}

const SOURCES: readonly ChangeSource[] = ['feed', 'accept', 'head-walk', 'census', 'visit', 'list'];

/** Histories over a few days: 2–8 headers, up to 30 changes, plan-days of 12–36 h. */
export const arbGrowthHistory: fc.Arbitrary<GrowthHistory> = fc
  .record({
    gaps: fc.array(fc.integer({ min: 1, max: 30 * HOUR }), { minLength: 1, maxLength: 7 }),
    counts: fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 8, maxLength: 8 }),
    following: fc.array(fc.integer({ min: 0, max: 5_000 }), { minLength: 8, maxLength: 8 }),
    dayLengths: fc.array(fc.integer({ min: 12 * HOUR, max: 36 * HOUR }), { minLength: 12, maxLength: 12 }),
    phase: fc.integer({ min: 0, max: 24 * HOUR }),
    raw: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }),
      fc.boolean(), fc.integer({ min: 0, max: SOURCES.length - 1 })), { maxLength: 30 }),
  })
  .map(({ gaps, counts, following, dayLengths, phase, raw }) => {
    const start = 1_000 * HOUR;
    const times = [start];
    for (const g of gaps) times.push(times[times.length - 1] + g);
    const headers = times.map((at, i) => ({ at, followers: counts[i], following: following[i] }));
    const span = times[times.length - 1] - start;
    const changes = raw.map(([a, b, gain, s], id): FollowerChange => {
      const x = start + 1 + Math.floor(a * (span - 1));
      const y = start + 1 + Math.floor(b * (span - 1));
      return { id: id + 1, accountPk: `p${id}`, delta: gain ? 1 : -1, lo: Math.min(x, y), hi: Math.max(x, y),
        source: SOURCES[s], foundAt: Math.max(x, y) };
    });
    const boundaries = [start - phase];
    for (const len of dayLengths) boundaries.push(boundaries[boundaries.length - 1] + len);
    return { headers, changes, windowOf: windowsFrom(boundaries) };
  });

/** Epo's writes spread over a span: follows (some to private accounts) and unfollows. */
export const arbEpoWrites = (from: number, to: number): fc.Arbitrary<EpoWrite[]> =>
  fc.array(fc.record({
    at: fc.integer({ min: from, max: to }),
    action: fc.constantFrom<'follow' | 'unfollow'>('follow', 'unfollow'),
    private: fc.boolean(),
  }), { maxLength: 20 });
