import { dailyRateView, hoursOpen } from '@/renderer/lib/engine-view';
import type { EpoStatus, Settings } from '@/types';

const statusWith = (actionsToday: number, plannedToday?: number): EpoStatus =>
  ({ actionsToday, plannedToday }) as EpoStatus;
const settingsWith = (dailyOperatingRate: number): Settings => ({ dailyOperatingRate }) as Settings;

describe('dailyRateView — the shared Actions-today meter model', () => {
  it("prefers the engine's cycle plan as the denominator so the meter can complete", () => {
    expect(dailyRateView(statusWith(11, 22), settingsWith(25))).toEqual({
      done: 11,
      rate: 22,
      pct: 50,
    });
  });

  it('falls back to the configured rate before the plan arrives', () => {
    expect(dailyRateView(statusWith(10), settingsWith(25))).toEqual({
      done: 10,
      rate: 25,
      pct: 40,
    });
  });

  it('caps the percent at 100 when done exceeds the rate', () => {
    expect(dailyRateView(statusWith(30), settingsWith(25)).pct).toBe(100);
  });

  it('yields zeroed defaults before status/settings arrive', () => {
    expect(dailyRateView(null, null)).toEqual({ done: 0, rate: null, pct: 0 });
    expect(dailyRateView(statusWith(5), null)).toEqual({ done: 5, rate: null, pct: 0 });
  });

  it('treats a zero rate as an empty meter (no divide-by-zero)', () => {
    expect(dailyRateView(statusWith(5), settingsWith(0)).pct).toBe(0);
  });
});

// Sanity anchor for the module's existing pure helper (documents co-location).
describe('hoursOpen', () => {
  it('handles a wrap-around window', () => {
    const s = { activeHoursStart: 22, activeHoursEnd: 6 } as Settings;
    expect(hoursOpen(s, 23)).toBe(true);
    expect(hoursOpen(s, 3)).toBe(true);
    expect(hoursOpen(s, 12)).toBe(false);
  });
});
