import fc from 'fast-check';
import {
  ceilTo,
  clampMs,
  days,
  divMs,
  fraction,
  hours,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  minutes,
  ms,
  mulMs,
  perDay,
  perHour,
  seconds,
} from '@/kernel/units';

describe('kernel/units', () => {
  it('converts through the one ladder of constants', () => {
    expect(seconds(1)).toBe(MS_PER_SECOND);
    expect(minutes(1)).toBe(MS_PER_MINUTE);
    expect(hours(1)).toBe(MS_PER_HOUR);
    expect(days(1)).toBe(MS_PER_DAY);
    expect(hours(1)).toBe(minutes(60));
  });

  it('refuses measurements that cannot exist', () => {
    expect(() => ms(-1)).toThrow(RangeError);
    expect(() => ms(Number.NaN)).toThrow(TypeError);
    expect(() => fraction(1.01)).toThrow(RangeError);
    expect(() => fraction(-0.01)).toThrow(RangeError);
    expect(() => perDay(-1)).toThrow(RangeError);
    expect(() => perHour(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => divMs(ms(1), 0)).toThrow(RangeError);
  });

  it('accepts the boundaries of a fraction', () => {
    expect(fraction(0)).toBe(0);
    expect(fraction(1)).toBe(1);
  });

  it('ceilTo rounds up to a whole step and is idempotent', () => {
    fc.assert(
      fc.property(fc.nat({ max: 100_000 }), fc.integer({ min: 1, max: 5_000 }), (value, step) => {
        const up = ceilTo(ms(value), ms(step));
        expect(up).toBeGreaterThanOrEqual(value);
        expect(up % step).toBe(0);
        expect(up - value).toBeLessThan(step);
        expect(ceilTo(up, ms(step))).toBe(up);
      }),
    );
  });

  it('clampMs lands inside the bounds however they are ordered', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), fc.nat({ max: 10_000 }), (value, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const forwards = clampMs(ms(value), ms(lo), ms(hi));
        expect(forwards).toBeGreaterThanOrEqual(lo);
        expect(forwards).toBeLessThanOrEqual(hi);
        expect(clampMs(ms(value), ms(hi), ms(lo))).toBe(forwards);
      }),
    );
  });

  it('scales durations without ever producing a negative one', () => {
    expect(mulMs(minutes(2), 1.5)).toBe(minutes(3));
    expect(divMs(hours(1), 4)).toBe(minutes(15));
    expect(() => mulMs(minutes(1), -1)).toThrow(RangeError);
  });
});
