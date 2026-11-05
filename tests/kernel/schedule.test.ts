import fc from 'fast-check';
import {
  attempts,
  describe as describeSchedule,
  draw,
  exponential,
  formatMs,
  jittered,
  logNormal,
  normal01,
  once,
  type Rng,
  recurs,
  type Schedule,
  truncate,
} from '@/kernel/schedule';
import { hours, minutes, ms, seconds } from '@/kernel/units';

/** A deterministic uniform source, so every property is reproducible. */
function rngFrom(seed: number): Rng {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** The recovery ladder, written as one value. */
const LADDER: Schedule = truncate(jittered(exponential(hours(1), 1.5, hours(4)), 0.25, [0.6, 1.6]), 3);

describe('kernel/schedule', () => {
  it('describes itself as the expression that built it', () => {
    expect(describeSchedule(LADDER)).toBe('truncate(jittered(exponential(1h, ×1.5, cap 4h), σ0.25, [0.6, 1.6]), 3)');
    expect(formatMs(seconds(90))).toBe('1.5m');
    expect(formatMs(ms(250))).toBe('250ms');
  });

  it('refuses a schedule that would descend or jitter negatively', () => {
    expect(() => exponential(hours(1), 0.9, hours(4))).toThrow(RangeError);
    expect(() => jittered(once(minutes(1)), -1, [0.6, 1.6])).toThrow(RangeError);
    expect(() => jittered(once(minutes(1)), 0.25, [1.6, 0.6])).toThrow(RangeError);
    expect(() => truncate(once(minutes(1)), -1)).toThrow(RangeError);
    expect(() => draw(once(minutes(1)), -1, rngFrom(1))).toThrow(RangeError);
  });

  it('exponential is monotone in attempt and never exceeds its cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.double({ min: 1, max: 4, noNaN: true }),
        fc.integer({ min: 1, max: 86_400_000 }),
        fc.nat({ max: 40 }),
        fc.nat({ max: 40 }),
        (base, factor, cap, a, b) => {
          const s = exponential(ms(base), factor, ms(cap));
          const rng = rngFrom(1);
          const lo = draw(s, Math.min(a, b), rng);
          const hi = draw(s, Math.max(a, b), rng);
          expect(lo).not.toBeNull();
          expect(hi).not.toBeNull();
          expect(hi as number).toBeGreaterThanOrEqual(lo as number);
          expect(hi as number).toBeLessThanOrEqual(cap);
        },
      ),
    );
  });

  it('jittered stays inside its clamp for every rng', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7_200_000 }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        fc.double({ min: 0.1, max: 1, noNaN: true }),
        fc.double({ min: 1, max: 3, noNaN: true }),
        fc.integer(),
        (base, sigma, lo, hi, seed) => {
          const s = jittered(once(ms(base)), sigma, [lo, hi]);
          const value = draw(s, 0, rngFrom(seed));
          expect(value).not.toBeNull();
          expect(value as number).toBeGreaterThanOrEqual(Math.floor(base * lo));
          expect(value as number).toBeLessThanOrEqual(Math.ceil(base * hi));
        },
      ),
    );
  });

  it('truncate exhausts after exactly n attempts', () => {
    fc.assert(
      fc.property(fc.nat({ max: 12 }), fc.nat({ max: 20 }), fc.integer(), (n, attempt, seed) => {
        const s = truncate(exponential(minutes(1), 2, hours(4)), n);
        const value = draw(s, attempt, rngFrom(seed));
        expect(value === null).toBe(attempt >= n);
        expect(attempts(s)).toBe(n);
      }),
    );
  });

  it('once and recurs exhaust on their own terms', () => {
    const rng = rngFrom(7);
    expect(draw(once(minutes(5)), 0, rng)).toBe(minutes(5));
    expect(draw(once(minutes(5)), 1, rng)).toBeNull();
    expect(draw(recurs(minutes(5), 3), 2, rng)).toBe(minutes(5));
    expect(draw(recurs(minutes(5), 3), 3, rng)).toBeNull();
    expect(attempts(once(minutes(5)))).toBe(1);
    expect(attempts(exponential(minutes(1), 2, hours(1)))).toBeNull();
    expect(attempts(jittered(recurs(minutes(1), 4), 0.1, [0.5, 2]))).toBe(4);
  });

  it('the recovery ladder serves three rungs of the right magnitude', () => {
    const rng = rngFrom(99);
    const rungs = [0, 1, 2].map((n) => draw(LADDER, n, rng));
    expect(rungs.every((r) => r !== null)).toBe(true);
    expect(draw(LADDER, 3, rng)).toBeNull();
    expect(rungs[0] as number).toBeGreaterThanOrEqual(Math.floor(hours(1) * 0.6));
    expect(rungs[2] as number).toBeLessThanOrEqual(Math.ceil(hours(2.25) * 1.6));
  });

  it('logNormal is median-centred and consumes the rng exactly twice', () => {
    let draws = 0;
    const counting: Rng = () => {
      draws += 1;
      return 0.5;
    };
    logNormal(minutes(10), 0.25, counting);
    expect(draws).toBe(2);

    const stream = rngFrom(4_242);
    const samples = Array.from({ length: 2_000 }, () => logNormal(minutes(10), 0.5, stream));
    const above = samples.filter((s) => s > minutes(10)).length;
    expect(above / samples.length).toBeGreaterThan(0.4);
    expect(above / samples.length).toBeLessThan(0.6);
  });

  it('normal01 produces a standard normal', () => {
    const stream = rngFrom(31_337);
    const xs = Array.from({ length: 4_000 }, () => normal01(stream));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.1);
  });
});
