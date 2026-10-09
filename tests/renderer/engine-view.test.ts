import { dailyRateView, hoursOpen, transportModel } from '@/renderer/lib/engine-view';
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

describe('transportModel — ONE transport for two drivers (unified status)', () => {
  it('defers to the growth engine when no prune is active', () => {
    expect(transportModel('running', 'idle')).toEqual({
      state: 'running',
      driver: 'growth',
      pruneScanning: false,
    });
    expect(transportModel(undefined, undefined)).toEqual({
      state: 'idle',
      driver: 'growth',
      pruneScanning: false,
    });
    expect(transportModel('halted', 'done')).toEqual({
      state: 'halted',
      driver: 'growth',
      pruneScanning: false,
    });
  });

  it('a prune run reads as running and takes the transport', () => {
    expect(transportModel('idle', 'running')).toEqual({
      state: 'running',
      driver: 'prune',
      pruneScanning: false,
    });
  });

  it('a prune scan reads as running with the pause lock flagged', () => {
    expect(transportModel('idle', 'scanning')).toEqual({
      state: 'running',
      driver: 'prune',
      pruneScanning: true,
    });
  });

  it('a prune outranks the growth engine it parked underneath', () => {
    expect(transportModel('paused', 'running')).toEqual({
      state: 'running',
      driver: 'prune',
      pruneScanning: false,
    });
  });

  it('a paused prune reads as paused so Resume routes back to it', () => {
    expect(transportModel('idle', 'paused')).toEqual({
      state: 'paused',
      driver: 'prune',
      pruneScanning: false,
    });
  });
});
