import { type CircadianProfile, intensityAt } from '@/timing/circadian';

/** The default triple-peak profile (mirrors CIRCADIAN in timing/config). */
const DEFAULT: CircadianProfile = {
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

// Jan 5 2026 is a Monday; local-constructor timestamps are timezone-robust.
const mon = (h: number, m = 0): number => new Date(2026, 0, 5, h, m).getTime();
const sat = (h: number, m = 0): number => new Date(2026, 0, 10, h, m).getTime();

describe('circadian/intensityAt', () => {
  test('deep night is near the floor', () => {
    expect(intensityAt(mon(4), DEFAULT)).toBeLessThan(0.06);
  });

  test('the evening peak hour is ~maximal', () => {
    expect(intensityAt(mon(18), DEFAULT)).toBeGreaterThan(0.95);
  });

  test('lunch sits mid-band', () => {
    const v = intensityAt(mon(13), DEFAULT);
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThan(0.95);
  });

  test('rises into the morning peak (04:00 < 06:00 < 08:00)', () => {
    expect(intensityAt(mon(6), DEFAULT)).toBeGreaterThan(intensityAt(mon(4), DEFAULT));
    expect(intensityAt(mon(8), DEFAULT)).toBeGreaterThan(intensityAt(mon(6), DEFAULT));
  });

  test('a zero day-of-week weight zeroes the whole day', () => {
    const zeroed: CircadianProfile = { ...DEFAULT, dayOfWeekWeights: [0, 0, 0, 0, 0, 0, 0] };
    expect(intensityAt(mon(18), zeroed)).toBe(0);
  });

  test('phase offset shifts the curve: intensityAt(t, off=2) == intensityAt(t+2h, off=0)', () => {
    const off2: CircadianProfile = { ...DEFAULT, phaseOffsetHours: 2 };
    const off0: CircadianProfile = { ...DEFAULT, phaseOffsetHours: 0 };
    expect(intensityAt(mon(12), off2)).toBeCloseTo(intensityAt(mon(14), off0), 10);
  });

  test('weekend shift moves the evening peak later in local time', () => {
    const p: CircadianProfile = {
      bumps: [{ centerHour: 18, amplitude: 1, widthHours: 2 }],
      overnightFloor: 0,
      dayOfWeekWeights: [1, 1, 1, 1, 1, 1, 1],
      weekendShiftHours: 2,
      phaseOffsetHours: 0,
    };
    expect(intensityAt(sat(20), p)).toBeGreaterThan(0.95); // peak felt at 20:00 on Saturday
    expect(intensityAt(mon(20), p)).toBeLessThan(0.7); // still on the decay on a weekday
  });
});
