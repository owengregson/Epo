/**
 * Which side of a prune census may turn ABSENCE into a verdict. A walk reports
 * completion and still misses rows, so each side answers for its own coverage
 * of the profile header's count (docs/PRINCIPLES.md §1: verdicts wait).
 */
import { censusAuthority, coverageVerdict } from '@/engine/census-authority';
import { assertFetchComplete, assertScanCoverage } from '@/engine/prune-scan-guards';
import { CENSUS_POLICY } from '@/kernel/census-policy';

describe('coverageVerdict (spec §10.4): a census covers the header it was taken against', () => {
  test('an unknown header fails closed', () => {
    expect(coverageVerdict(500, null, 0)).toEqual({ ok: false, reason: 'header-unknown', scraped: 500, known: null });
  });

  test('a header below the floor passes: tiny accounts are ghost-dominated', () => {
    expect(coverageVerdict(3, CENSUS_POLICY.coverageFloor - 1, 0)).toEqual({ ok: true, ghosts: CENSUS_POLICY.coverageFloor - 4 });
  });

  test('a list short of the coverage share fails; within it, the difference is ghosts', () => {
    expect(coverageVerdict(38, 3200, 0)).toEqual({ ok: false, reason: 'short', scraped: 38, known: 3200 });
    expect(coverageVerdict(96, 100, 0)).toEqual({ ok: true, ghosts: 4 });
    expect(coverageVerdict(101, 100, 0)).toEqual({ ok: true, ghosts: 0 });
  });

  test('quarantined rows refuse an otherwise covered census', () => {
    expect(coverageVerdict(100, 100, 1)).toEqual({ ok: false, reason: 'row-issues', scraped: 100, known: 100 });
  });
});

describe('the prune scan guards', () => {
  const fetch = (over: object) => ({ pks: ['a'], complete: true, reason: 'no-more-pages', ...over });

  test('a complete walk with quarantined rows is refused: an unreadable row is never a missing follower', () => {
    expect(() => assertFetchComplete('followers', fetch({ quarantined: 2 }))).toThrow(/row-issues/);
    expect(() => assertFetchComplete('followers', fetch({ quarantined: 0 }))).not.toThrow();
  });

  test('an unknown header fails the scan closed when the scan refreshed it; never silently skipped', () => {
    expect(() => assertScanCoverage('followers', 10, null, { headerRequired: true })).toThrow(/follower count/);
    expect(() => assertScanCoverage('followers', 10, null)).not.toThrow();
  });

  test('a short census and a quarantined one both throw', () => {
    expect(() => assertScanCoverage('followers', 38, 3200)).toThrow(/followers scan incomplete/);
    expect(() => assertScanCoverage('following', 100, 100, { quarantined: 3 })).toThrow(/row-issues/);
  });
});

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

  test('a side with quarantined rows proves nothing, whatever it covers', () => {
    expect(censusAuthority(101, 40, { following: 100, followers: 40 }, { following: 0, followers: 1 })).toEqual({
      following: true,
      followers: false,
    });
  });
});
