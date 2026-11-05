/**
 * The schedule derivations (ADR 0608, spec §6.2): the derived quiet window pinned per day shape, the masked
 * session mass equal to the kernel's unmasked integral, the hourly previews and the feasibility rule.
 */

import { deriveOperatingPlan, sessionMassHours } from '@/kernel';
import { ENVELOPE, GRID_BASE } from '@/kernel/derive-envelope';
import {
  deriveQuietHours, feasibility, hourlyIntensity, inWindow, sessionMassMasked,
} from '@/kernel/derive-schedule';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';

const SHAPES = ['balanced', 'morning', 'evening', 'nightowl', 'business'] as const;
const WEEKS = ['realistic', 'uniform', 'weekdays', 'weekends'] as const;
const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('the derived quiet window per day shape (the spec pins these)', () => {
  const windows = Object.fromEntries(SHAPES.map((s) => {
    const q = deriveQuietHours(s);
    return [s, `${hhmm(q.startMinute)}–${hhmm(q.endMinute)}`];
  }));
  expect(windows).toEqual({
    balanced: '23:30–06:00', morning: '22:30–05:00', evening: '01:00–06:30', nightowl: '04:30–08:00',
    business: '22:00–05:30',
  });
});

test('every derived window sits on the grid, is non-empty and no longer than the policy allows', () => {
  for (const s of SHAPES) {
    const q = deriveQuietHours(s);
    expect(q.startMinute % SETTINGS_POLICY.QUIET_GRID_MINUTES).toBe(0);
    expect(q.endMinute % SETTINGS_POLICY.QUIET_GRID_MINUTES).toBe(0);
    expect(q.startMinute).not.toBe(q.endMinute);
    const length = (q.endMinute - q.startMinute + 1440) % 1440;
    expect(length).toBeLessThanOrEqual(SETTINGS_POLICY.QUIET_MAX_HOURS * 60);
  }
});

test('inWindow handles plain and wrapping windows', () => {
  expect(inWindow(60, { startMinute: 1410, endMinute: 360 })).toBe(true);
  expect(inWindow(1420, { startMinute: 1410, endMinute: 360 })).toBe(true);
  expect(inWindow(720, { startMinute: 1410, endMinute: 360 })).toBe(false);
  expect(inWindow(360, { startMinute: 1410, endMinute: 360 })).toBe(false);
  expect(inWindow(300, { startMinute: 60, endMinute: 390 })).toBe(true);
});

test('law: with nothing masked the session mass is the kernel integral, for every shape pair', () => {
  for (const dayShape of SHAPES) {
    for (const weeklyShape of WEEKS) {
      expect(sessionMassMasked({ dayShape, weeklyShape }, null, [])).toBe(sessionMassHours({ dayShape, weeklyShape }));
    }
  }
});

test('masking only removes mass: quiet hours and days off never add any', () => {
  const p = { dayShape: 'balanced', weeklyShape: 'realistic' } as const;
  const full = sessionMassMasked(p, null, []);
  const quiet = sessionMassMasked(p, deriveQuietHours('balanced'), []);
  const off = sessionMassMasked(p, deriveQuietHours('balanced'), [0, 6]);
  expect(quiet).toBeLessThan(full);
  expect(off).toBeLessThan(quiet);
  expect(sessionMassMasked(p, null, [0, 1, 2, 3, 4, 5, 6])).toBe(0);
});

test('the hourly previews are 24 intensities in [0, 1], peaking in the day', () => {
  for (const s of SHAPES) {
    const xs = hourlyIntensity(s, 'realistic', 3);
    expect(xs).toHaveLength(24);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  }
  const balanced = hourlyIntensity('balanced', 'realistic', 3);
  expect(balanced.indexOf(Math.max(...balanced))).toBeGreaterThan(8);
});

test("feasibility: reachable when the cap covers the volume; else the cap or the active time binds", () => {
  expect(feasibility({ dailyVolume: 50, hourlyCap: 22, massHours: 12 })).toEqual({ kind: 'ok', reachablePerDay: 264, binding: null });
  expect(feasibility({ dailyVolume: 100, hourlyCap: 14, massHours: 5 })).toEqual({ kind: 'short', reachablePerDay: 70, binding: 'hourly-cap' });
  expect(feasibility({ dailyVolume: 100, hourlyCap: 14, massHours: 3 })).toEqual({ kind: 'short', reachablePerDay: 42, binding: 'active-time' });
});

test("feasibility agrees with the kernel's operating plan on every unmasked grid shape", () => {
  for (const dayShape of SHAPES) {
    const p = { ...GRID_BASE, dayShape, activityLevel: 'aggressive', caution: 'cautious' } as const;
    const plan = deriveOperatingPlan(p);
    const f = feasibility({ dailyVolume: plan.dailyPlan, hourlyCap: plan.hourlyCap, massHours: sessionMassHours(p) });
    expect(f.kind === 'ok').toBe(plan.kind === 'coherent');
    if (plan.kind === 'conflict') expect(f.binding).toBe(plan.binding === 'hourlyCap' ? 'hourly-cap' : 'active-time');
  }
  expect(ENVELOPE.hourlyCap.max).toBe(30);
});
