import {
  clamp,
  logNormal,
  logNormalMixture,
  normal01,
  pareto,
  weibull,
} from '@/timing/distributions';
import { sample } from '@/timing/primitives';

/** A deterministic rng that replays the given values in order (cycling). */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

/** A counting wrapper: reports how many times the rng was invoked. */
const counting = (
  inner: () => number,
): { rng: () => number; calls: () => number } => {
  let n = 0;
  return {
    rng: () => {
      n += 1;
      return inner();
    },
    calls: () => n,
  };
};

/** mulberry32 — deterministic PRNG for statistical assertions. */
const mulberry32 = (seed: number) => (): number => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('distributions/normal01 — Box–Muller', () => {
  test('consumes exactly two rng draws', () => {
    const c = counting(seq(0.3, 0.7));
    normal01(c.rng);
    expect(c.calls()).toBe(2);
  });

  test('u1=1 (first draw 0) yields Z=0 regardless of the second draw', () => {
    // u1 = 1 - rng() = 1 → ln(1) = 0 → Z = 0
    expect(normal01(seq(0, 0.42))).toBe(0);
  });

  test('is a standard normal: mean ~0, sd ~1 over many samples', () => {
    const rng = mulberry32(1);
    const xs = Array.from({ length: 20000 }, () => normal01(rng));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const varc = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(Math.sqrt(varc) - 1)).toBeLessThan(0.03);
  });
});

describe('distributions/logNormal', () => {
  test('Z=0 draw returns the median (rounded)', () => {
    expect(sample(logNormal(60_000, 0.75), seq(0, 0))).toBe(60_000);
  });

  test('every draw is a positive integer', () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 500; i++) {
      const v = sample(logNormal(90_000, 0.8), rng);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  test('empirical median tracks the parameter', () => {
    const rng = mulberry32(3);
    const xs = Array.from({ length: 20000 }, () => sample(logNormal(95_000, 0.75), rng)).sort(
      (a, b) => a - b,
    );
    const median = xs[Math.floor(xs.length / 2)];
    expect(Math.abs(median - 95_000) / 95_000).toBeLessThan(0.04);
  });
});

describe('distributions/logNormalMixture', () => {
  const comps = [
    { weight: 4, medianMs: 90_000, sigma: 0.5 }, // normalizes to 0.8
    { weight: 1, medianMs: 6 * 3600_000, sigma: 0.5 }, // normalizes to 0.2
  ];

  test('picks the first component when the selector draw is below its cumulative weight', () => {
    // selector 0.1 < 0.8 → comp0; then Z=0 → comp0 median
    expect(sample(logNormalMixture(comps), seq(0.1, 0, 0))).toBe(90_000);
  });

  test('picks the second component when the selector draw is above the first weight', () => {
    expect(sample(logNormalMixture(comps), seq(0.9, 0, 0))).toBe(6 * 3600_000);
  });

  test('two well-separated components produce a bimodal sample set', () => {
    const rng = mulberry32(4);
    const xs = Array.from({ length: 10000 }, () => sample(logNormalMixture(comps), rng));
    const lowShare = xs.filter((x) => x < 30 * 60_000).length / xs.length; // < 30 min
    expect(lowShare).toBeGreaterThan(0.72);
    expect(lowShare).toBeLessThan(0.88);
  });
});

describe('distributions/weibull', () => {
  test('shape 1 reduces to the exponential inverse-CDF', () => {
    // X = scale * (-ln(1-u))^(1/1); u=0.5 → -ln(0.5)=0.6931 → 693
    expect(sample(weibull(1000, 1), seq(0.5))).toBe(693);
  });

  test('P(X < scale) ~ 1 - e^-1 for shape 1', () => {
    const rng = mulberry32(5);
    const xs = Array.from({ length: 20000 }, () => sample(weibull(7000, 1), rng));
    const share = xs.filter((x) => x < 7000).length / xs.length;
    expect(Math.abs(share - (1 - Math.exp(-1)))).toBeLessThan(0.02);
  });

  test('every draw is a positive integer', () => {
    const rng = mulberry32(6);
    for (let i = 0; i < 300; i++) {
      const v = sample(weibull(7000, 0.85), rng);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('distributions/pareto — bounded power law', () => {
  test('u=0 returns xMin, u=1 returns xMax', () => {
    expect(sample(pareto(1000, 1.2, 60_000), seq(0))).toBe(1000);
    expect(sample(pareto(1000, 1.2, 60_000), seq(1))).toBe(60_000);
  });

  test('all draws stay within [xMin, xMax]', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = sample(pareto(1000, 1.2, 60_000), rng);
      expect(v).toBeGreaterThanOrEqual(1000);
      expect(v).toBeLessThanOrEqual(60_000);
    }
  });
});

describe('distributions/clamp — bounded re-draw', () => {
  test('passes through an in-range draw on the first try', () => {
    const c = counting(seq(0.5));
    // logNormal(1000, 0) is deterministically 1000 (sigma 0 → Z*0), within [500, 2000]
    const v = sample(clamp(logNormal(1000, 0), 500, 2000), c.rng);
    expect(v).toBe(1000);
  });

  test('projects onto the nearer bound after 4 failed inner draws', () => {
    const c = counting(seq(0, 0)); // logNormal(100_000,0) = 100_000, always above the cap
    const v = sample(clamp(logNormal(100_000, 0), 500, 2000), c.rng);
    expect(v).toBe(2000); // projected to max (nearer bound)
    // 4 inner attempts, each consuming normal01's 2 draws → at most 8 rng calls
    expect(c.calls()).toBeLessThanOrEqual(8);
  });

  test('never returns a value outside the bounds', () => {
    const rng = mulberry32(8);
    for (let i = 0; i < 2000; i++) {
      const v = sample(clamp(logNormal(1500, 1.2), 800, 4000), rng);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(4000);
    }
  });
});
