import {
  type CircadianProfile,
  intensityAt,
  sampleNextSessionStart,
  samplePhaseOffset,
} from '@/timing/circadian';

const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

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

describe('circadian/sampleNextSessionStart — Lewis thinning', () => {
  test('returns a strictly future time', () => {
    const from = mon(9);
    const next = sampleNextSessionStart(from, DEFAULT, 6, mulberry32(1));
    expect(next).toBeGreaterThan(from);
  });

  test('sampled starts track the intensity curve (hourly counts correlate with λ)', () => {
    const rng = mulberry32(42);
    let t = mon(0);
    const hourCounts = new Array(24).fill(0);
    for (let i = 0; i < 4000; i++) {
      t = sampleNextSessionStart(t, DEFAULT, 6, rng);
      hourCounts[new Date(t).getHours()] += 1;
    }
    const intens = Array.from({ length: 24 }, (_, h) => intensityAt(mon(h, 30), DEFAULT));
    // Pearson correlation between the hourly histogram and the intensity curve.
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
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
    const r = num / Math.sqrt(dc * di);
    expect(r).toBeGreaterThan(0.8);
    // Almost nothing lands in the 02:00–05:00 trough.
    const trough = hourCounts[2] + hourCounts[3] + hourCounts[4];
    expect(trough / 4000).toBeLessThan(0.02);
  });

  test('an all-zero-intensity profile hits the cap and falls back to from + 24h', () => {
    const dead: CircadianProfile = { ...DEFAULT, dayOfWeekWeights: [0, 0, 0, 0, 0, 0, 0] };
    const from = mon(9);
    expect(sampleNextSessionStart(from, dead, 6, mulberry32(2))).toBe(from + 24 * 3600_000);
  });
});

describe('circadian/samplePhaseOffset', () => {
  test('maps the rng across [-max, +max]', () => {
    expect(samplePhaseOffset(1.5, seq(0))).toBeCloseTo(-1.5, 10);
    expect(samplePhaseOffset(1.5, seq(1))).toBeCloseTo(1.5, 10);
    expect(samplePhaseOffset(1.5, seq(0.5))).toBeCloseTo(0, 10);
  });
});
