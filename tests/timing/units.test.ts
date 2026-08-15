import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE, startOfLocalDay } from '@/timing/units';

describe('timing/units', () => {
  test('unit constants compose consistently', () => {
    expect(MS_PER_MINUTE).toBe(60_000);
    expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
    expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
  });

  test('startOfLocalDay returns local midnight of the containing day', () => {
    const noon = Date.parse('2026-08-12T12:34:56');
    expect(startOfLocalDay(noon)).toBe(Date.parse('2026-08-12T00:00:00'));
    // Already-midnight input is a fixed point.
    expect(startOfLocalDay(startOfLocalDay(noon))).toBe(startOfLocalDay(noon));
    // The last ms of the day still maps to the same midnight.
    expect(startOfLocalDay(Date.parse('2026-08-12T23:59:59.999'))).toBe(
      Date.parse('2026-08-12T00:00:00'),
    );
  });
});
