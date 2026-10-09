/**
 * Which side of a prune census may turn ABSENCE into a verdict. A walk reports
 * completion and still misses rows, so each side answers for its own coverage
 * of the profile header's count (docs/PRINCIPLES.md §1: verdicts wait).
 */
import { censusAuthority } from '@/engine/census-authority';

describe('censusAuthority', () => {
  test('the live 2026-08-31 census: followers proven, following NOT', () => {
    expect(censusAuthority(2928, 3870, { following: 3329, followers: 3885 })).toEqual({
      following: false,
      followers: true,
    });
  });

  test('a side with no header count to answer to proves nothing', () => {
    expect(censusAuthority(10, 10, null)).toEqual({ following: false, followers: false });
    expect(censusAuthority(10, 10, { followers: 10 })).toEqual({ following: false, followers: true });
  });

  test('a list at or above the header count is proven (the header lags, never the list)', () => {
    expect(censusAuthority(101, 40, { following: 100, followers: 40 })).toEqual({
      following: true,
      followers: true,
    });
  });
});
