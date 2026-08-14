/**
 * NumberTicker math — formatting and the right-anchored column model that the
 * slot-machine digit animation rides on.
 */
import { formatTicker, tickerCells } from '@/renderer/lib/ticker';

describe('formatTicker', () => {
  test('thousands-separates and rounds', () => {
    expect(formatTicker(0)).toBe('0');
    expect(formatTicker(4210)).toBe('4,210');
    expect(formatTicker(1234567)).toBe('1,234,567');
    expect(formatTicker(12.6)).toBe('13');
  });

  test('signed mode prefixes positives (and zero) with +', () => {
    expect(formatTicker(128, true)).toBe('+128');
    expect(formatTicker(0, true)).toBe('+0');
  });

  test('negatives always carry the minus, signed or not', () => {
    expect(formatTicker(-9)).toBe('-9');
    expect(formatTicker(-1234, true)).toBe('-1,234');
  });
});

describe('tickerCells', () => {
  test('splits digits and separators, keyed by distance from the right', () => {
    expect(tickerCells('4,210')).toEqual([
      { key: 5, char: '4', digit: 4 },
      { key: 4, char: ',', digit: null },
      { key: 3, char: '2', digit: 2 },
      { key: 2, char: '1', digit: 1 },
      { key: 1, char: '0', digit: 0 },
    ]);
  });

  test('sign prefixes are static separator cells', () => {
    const cells = tickerCells('+12');
    expect(cells[0]).toEqual({ key: 3, char: '+', digit: null });
    expect(cells[1].digit).toBe(1);
    expect(cells[2].digit).toBe(2);
  });

  test('right-anchoring keeps the low digits on stable keys across a length change', () => {
    const before = tickerCells('999'); // keys [3, 2, 1]
    const after = tickerCells('1,000'); // keys [5, 4, 3, 2, 1]
    // The three low columns keep their keys, so 999 → 1,000 rolls them in place.
    expect(before.map((c) => c.key)).toEqual([3, 2, 1]);
    expect(after.slice(-3).map((c) => c.key)).toEqual([3, 2, 1]);
  });

  test('empty string yields no cells', () => {
    expect(tickerCells('')).toEqual([]);
  });
});
