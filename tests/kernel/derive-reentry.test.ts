/**
 * The reopen derivations (D10, spec §9.5, §9.13): the weekly cycle is derived, not a new number, and
 * equals today's seven-day windows; the head walk, its allowance, the page size and the order check.
 */
import fc from 'fast-check';
import { driftConfirmThreshold } from '@/kernel/derive';
import {
  frontierRun, headPageAllowance, headWalkPages, measuredRowsPerPage, minOrderPairs, orderAgreementRequired, orderVerdict,
  WEEKLY_CYCLE,
} from '@/kernel/derive-reentry';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { POLICY } from '@/kernel/policy';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';

test('WEEKLY_CYCLE is the period of the weekly activity shape', () => {
  expect(WEEKLY_CYCLE).toBe(EMPIRICAL.HUMAN_CIRCADIAN.dayOfWeek.length);
  expect(WEEKLY_CYCLE).toBe(7);
});

test('the reentry bounds are the spec values', () => {
  // FOLLOWING_WALK_PAGES is spec §9.2's SURFACE.followingWalkPages: the ordered response plus one plain probe.
  expect(BOUNDS_REENTRY).toEqual({ MIN_ROWS_PER_PAGE: 10, FRONTIER_PAGES_MAX: 5, FOLLOWING_WALK_PAGES: 2 });
});

describe('the head walk and the frontier (spec §9.5)', () => {
  const MAX = BOUNDS_REENTRY.FRONTIER_PAGES_MAX;
  const MIN = BOUNDS_REENTRY.MIN_ROWS_PER_PAGE;
  const need = fc.record({
    identifiedSinceFrontier: fc.integer({ min: 0, max: 400 }),
    unexplainedGains: fc.integer({ min: 0, max: 400 }),
    rowsPerPage: fc.option(fc.double({ min: 1, max: 60, noNaN: true })),
    pagesAvailable: fc.integer({ min: 0, max: 50 }),
  });

  test('a frontier run is the drift-confirmation count; the order check needs 50 pairs at 0.98', () => {
    expect(frontierRun()).toBe(driftConfirmThreshold());
    expect(frontierRun()).toBe(2);
    expect(orderAgreementRequired()).toBe(POLICY.CENSUS_ABSENCE_COVERAGE);
    expect(minOrderPairs()).toBe(50);
  });

  test('head-walk pages: the gains over the page size plus the run, never past the bounds', () => {
    expect(headWalkPages({ identifiedSinceFrontier: 0, unexplainedGains: 0, rowsPerPage: 25, pagesAvailable: 9 })).toBe(2);
    expect(headWalkPages({ identifiedSinceFrontier: 30, unexplainedGains: 20, rowsPerPage: 25, pagesAvailable: 9 })).toBe(4);
    expect(headWalkPages({ identifiedSinceFrontier: 900, unexplainedGains: 0, rowsPerPage: 25, pagesAvailable: 9 })).toBe(MAX);
    expect(headWalkPages({ identifiedSinceFrontier: 10, unexplainedGains: 0, rowsPerPage: 25, pagesAvailable: 1 })).toBe(1);
    // A page size below the fault floor sizes like the floor.
    expect(headWalkPages({ identifiedSinceFrontier: 12, unexplainedGains: 0, rowsPerPage: 3, pagesAvailable: 9 })).toBe(4);
  });

  test('head-walk pages are monotone in both gain terms and bounded (law L1: only the delta)', () => {
    fc.assert(fc.property(need, fc.integer({ min: 0, max: 50 }), (n, more) => {
      const pages = headWalkPages(n);
      expect(pages).toBeGreaterThanOrEqual(0);
      expect(pages).toBeLessThanOrEqual(Math.min(MAX, n.pagesAvailable));
      expect(headWalkPages({ ...n, identifiedSinceFrontier: n.identifiedSinceFrontier + more })).toBeGreaterThanOrEqual(pages);
      expect(headWalkPages({ ...n, unexplainedGains: n.unexplainedGains + more })).toBeGreaterThanOrEqual(pages);
    }));
  });

  test('the per-walk allowance sizes a hint the same way, bounded by the frontier term', () => {
    expect(headPageAllowance({ gainsHint: 0, rowsPerPage: null })).toBe(2);
    expect(headPageAllowance({ gainsHint: 15, rowsPerPage: null })).toBe(4);
    expect(headPageAllowance({ gainsHint: 1_000, rowsPerPage: 25 })).toBe(MAX);
    fc.assert(fc.property(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 50 }), (g, more) => {
      expect(headPageAllowance({ gainsHint: g + more, rowsPerPage: 20 })).toBeGreaterThanOrEqual(
        headPageAllowance({ gainsHint: g, rowsPerPage: 20 }));
    }));
  });

  test('a measured page size below the fault floor never replaces the prior', () => {
    expect(measuredRowsPerPage({ rows: 100, fullPages: 4 }, null)).toBe(25);
    expect(measuredRowsPerPage({ rows: 18, fullPages: 3 }, 22)).toBe(22);
    expect(measuredRowsPerPage({ rows: 7, fullPages: 0 }, 22)).toBe(22);
    expect(measuredRowsPerPage({ rows: MIN * 2, fullPages: 2 }, null)).toBe(MIN);
  });

  test('the order verdict needs enough pairs; then agreement decides', () => {
    expect(orderVerdict(49, 49, 'unverified')).toBe('unverified');
    expect(orderVerdict(49, 0, 'newest-first')).toBe('newest-first');
    expect(orderVerdict(50, 49, 'unverified')).toBe('newest-first');
    expect(orderVerdict(50, 48, 'newest-first')).toBe('unverified');
  });
});
