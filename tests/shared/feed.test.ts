/**
 * `formatAgo` (spec Appendix C.1): "just now", minutes, hours and minutes on the same local day, "yesterday" with
 * the clock time, then the date; never a negative age.
 */

import { formatAgo } from '@/shared/feed';

const MIN = 60_000;
const time = (t: number): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(t);
const dateTime = (t: number): string =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);

const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();

test('under a minute, or a moment in the future, is just now', () => {
  const now = at(3, 15);
  expect(formatAgo(now, now)).toBe('just now');
  expect(formatAgo(now - MIN + 1, now)).toBe('just now');
  expect(formatAgo(now + 5 * MIN, now)).toBe('just now');
});

test('minutes under an hour, even across midnight', () => {
  expect(formatAgo(at(3, 14, 58), at(3, 15))).toBe('2m');
  expect(formatAgo(at(3, 14, 1), at(3, 15))).toBe('59m');
  expect(formatAgo(at(2, 23, 50), at(3, 0, 20))).toBe('30m');
});

test('hours and minutes on the same local day', () => {
  expect(formatAgo(at(3, 14), at(3, 15))).toBe('1h');
  expect(formatAgo(at(3, 13, 55), at(3, 15))).toBe('1h 5m');
  expect(formatAgo(at(3, 0, 5), at(3, 23, 59))).toBe('23h 54m');
});

test('the day before reads as yesterday with its clock time; older moments show their date', () => {
  expect(formatAgo(at(2, 15, 10), at(3, 9))).toBe(`yesterday ${time(at(2, 15, 10))}`);
  expect(formatAgo(at(2, 22), at(3, 0, 30))).toBe(`yesterday ${time(at(2, 22))}`);
  expect(formatAgo(at(1, 9), at(3, 9))).toBe(dateTime(at(1, 9)));
  expect(formatAgo(at(1, 9), at(1, 9) + 40 * 24 * 60 * MIN)).toBe(dateTime(at(1, 9)));
});
