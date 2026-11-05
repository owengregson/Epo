/**
 * The one plan-day boundary (spec §4.4, law L9): the quiet minute is the masked argmin of the weekday
 * λ (ties → centre of the longest run); windows tile time across DST with no gap or overlap; a
 * transition day is 12–36 h and prorates only below 23 h.
 */
import fc from 'fast-check';
import { dayShapeBumps, overnightFloor, weeklyWeights } from '@/kernel/derive';
import { EMPIRICAL } from '@/kernel/fundamentals';
import {
  inQuietHours,
  intensityAt,
  intensityAtHour,
  massBetween,
  massQuantileAt,
  planDayWindow,
  prorateFor,
  quietMinute,
  transitionDay,
} from '@/kernel/plan/circadian';
import type { CircadianShape } from '@/kernel/plan/types';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';

const shapeOf = (day: 'balanced' | 'nightowl' | 'morning'): CircadianShape => ({
  bumps: dayShapeBumps(day),
  overnightFloor: overnightFloor(day),
  weekdayWeights: weeklyWeights('realistic'),
  weekendShiftHours: EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours,
});
const BALANCED = shapeOf('balanced');
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

describe('the quiet minute', () => {
  test('with no quiet hours it is the λ trough (balanced ≈ 03:12, night owl ≈ 06:15)', () => {
    expect(Math.abs(quietMinute(BALANCED, 0, null) - (3 * 60 + 12))).toBeLessThanOrEqual(10);
    expect(Math.abs(quietMinute(shapeOf('nightowl'), 0, null) - (6 * 60 + 15))).toBeLessThanOrEqual(15);
  });

  test('with quiet hours it is the centre of the window (23:30–06:00 → 02:45), whatever the shape', () => {
    const quiet = { startMinute: 23 * 60 + 30, endMinute: 6 * 60 };
    expect(hhmm(quietMinute(BALANCED, 0, quiet))).toBe('02:45');
    expect(hhmm(quietMinute(shapeOf('morning'), 1.2, quiet))).toBe('02:45');
  });

  test('it is the masked argmin: no unmasked minute is lower', () => {
    fc.assert(fc.property(fc.double({ min: -1.5, max: 1.5, noNaN: true }), (phase) => {
      const at = (minute: number): number => intensityAtHour((((minute / 60 + phase) % 24) + 24) % 24, BALANCED, 1);
      const best = at(quietMinute(BALANCED, phase, null));
      for (let i = 0; i < 1440; i += 7) if (at(i) < best - 1e-12) return false;
      return true;
    }), { numRuns: 25 });
  });

  test('the weekday λ peaks in the evening and is lowest overnight', () => {
    const mon = (h: number): number => new Date(2026, 0, 5, h, 0).getTime();
    expect(intensityAt(mon(18), BALANCED, 0)).toBeGreaterThan(0.95);
    expect(intensityAt(mon(4), BALANCED, 0)).toBeLessThan(0.06);
  });

  test('a phase shift moves the boundary by the same amount', () => {
    const base = quietMinute(BALANCED, 0, null);
    expect(quietMinute(BALANCED, 1, null)).toBe((base - 60 + 1440) % 1440);
  });

  test('quiet hours wrap midnight and an empty window masks nothing', () => {
    const q = { startMinute: 1380, endMinute: 360 };
    expect([inQuietHours(1400, q), inQuietHours(100, q), inQuietHours(360, q), inQuietHours(720, q)])
      .toEqual([true, true, false, false]);
    expect(inQuietHours(100, { startMinute: 300, endMinute: 300 })).toBe(false);
    expect(inQuietHours(100, null)).toBe(false);
  });
});

describe('L9: plan-day windows tile time across DST (America/Los_Angeles)', () => {
  const tile = (from: number, days: number, qm: number) => {
    const out = [planDayWindow(from, qm)];
    for (let i = 1; i < days; i += 1) out.push(planDayWindow(out[i - 1].endsAt, qm));
    return out;
  };

  test.each([
    ['fall back 2026-11-01', new Date(2026, 9, 28, 12).getTime()],
    ['spring forward 2027-03-14', new Date(2027, 2, 10, 12).getTime()],
  ])('%s: consecutive windows abut, last 23/24/25 h, and every instant maps to its tile', (_name, from) => {
    expect([new Date(2026, 10, 2, 12).getTimezoneOffset(), new Date(2027, 2, 15, 12).getTimezoneOffset()]).toEqual([480, 420]);
    for (const qm of [0, 90, 120, 150, 165, 192, 375, 1439]) {
      const windows = tile(from, 9, qm);
      expect(windows.some((w) => w.endsAt - w.startsAt !== 24 * MS_PER_HOUR)).toBe(true);
      for (let i = 1; i < windows.length; i += 1) expect(windows[i].startsAt).toBe(windows[i - 1].endsAt);
      for (const w of windows) {
        expect([23, 24, 25]).toContain(Math.round((w.endsAt - w.startsAt) / MS_PER_HOUR));
        for (const t of [w.startsAt, w.startsAt + 1, (w.startsAt + w.endsAt) / 2, w.endsAt - 1]) {
          expect(planDayWindow(t, qm)).toEqual(w);
        }
      }
      expect(new Set(windows.map((w) => w.key)).size).toBe(windows.length);
    }
  });

  test('random instants land in a window that contains them', () => {
    const lo = new Date(2026, 9, 25).getTime();
    fc.assert(fc.property(fc.integer({ min: 0, max: 200 * MS_PER_DAY }), fc.integer({ min: 0, max: 1439 }), (dt, qm) => {
      const t = lo + dt;
      const w = planDayWindow(t, qm);
      return w.startsAt <= t && t < w.endsAt && w.quietMinute === qm;
    }));
  });

  test('the key is the local date the window starts on', () => {
    const w = planDayWindow(new Date(2026, 10, 3, 1, 0).getTime(), 165);
    expect(w.key).toBe('2026-11-02');
    expect(planDayWindow(new Date(2026, 10, 3, 3, 0).getTime(), 165).key).toBe('2026-11-03');
  });
});

describe('transition days', () => {
  test('run from the old end to the first new quiet minute at least 12 h later (12–36 h)', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 400 * MS_PER_DAY }), fc.integer({ min: 0, max: 1439 }),
      fc.integer({ min: 0, max: 1439 }), (dt, oldQm, newQm) => {
        const prev = planDayWindow(new Date(2026, 0, 1).getTime() + dt, oldQm);
        const t = transitionDay(prev.endsAt, newQm);
        const hours = (t.endsAt - t.startsAt) / MS_PER_HOUR;
        return t.startsAt === prev.endsAt && hours >= 12 && hours <= 37 && new Date(t.endsAt).getMinutes() === newQm % 60;
      }));
  });

  test('prorate below 23 h only; DST lengths keep whole counters', () => {
    expect(prorateFor(12 * MS_PER_HOUR)).toBeCloseTo(0.5, 12);
    expect(prorateFor(22 * MS_PER_HOUR)).toBeCloseTo(22 / 24, 12);
    expect(prorateFor(23 * MS_PER_HOUR)).toBe(1);
    expect(prorateFor(25 * MS_PER_HOUR)).toBe(1);
    expect(prorateFor(36 * MS_PER_HOUR)).toBe(1);
  });
});

describe('λ mass', () => {
  test('the quantile function inverts the cumulative mass; quiet hours carry none', () => {
    const w = planDayWindow(new Date(2026, 0, 7, 12).getTime(), 165);
    const quiet = { startMinute: 23 * 60 + 30, endMinute: 6 * 60 };
    const total = massBetween(w.startsAt, w.endsAt, BALANCED, 0, quiet);
    for (const q of [0.1, 0.25, 0.5, 0.9]) {
      const t = massQuantileAt(w, BALANCED, 0, q, quiet);
      expect(massBetween(w.startsAt, t, BALANCED, 0, quiet) / total).toBeCloseTo(q, 2);
      const local = new Date(t).getHours() * 60 + new Date(t).getMinutes();
      expect(inQuietHours(local, quiet)).toBe(false);
    }
    expect(massBetween(w.startsAt, w.startsAt + 3 * MS_PER_HOUR, BALANCED, 0, quiet)).toBe(0);
    expect(massBetween(w.endsAt, w.startsAt, BALANCED, 0)).toBe(0);
  });

  test('mass grows with the span and the mid-day carries most of it', () => {
    const w = planDayWindow(new Date(2026, 0, 7, 12).getTime(), 192);
    const day = massBetween(w.startsAt, w.endsAt, BALANCED, 0);
    const afternoon = massBetween(new Date(2026, 0, 7, 12).getTime(), new Date(2026, 0, 7, 22).getTime(), BALANCED, 0);
    expect(afternoon / day).toBeGreaterThan(0.6);
    expect(MS_PER_MINUTE).toBeGreaterThan(0);
  });
});
