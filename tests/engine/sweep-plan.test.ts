import { decideStep, type StepInputs, stale } from '@/engine/sweep-plan';
import type { ReopenState } from '@/store/repos/reopen-state';

const NOW = 1_000_000_000;
const SPACING = 3_600_000;
const TOL = 300_000;
const DAY_START = NOW - 5 * SPACING;

const state = (over: Partial<ReopenState> = {}): ReopenState => ({ v: 1, feed: null, requests: null, lastSweep: null,
  lastCatchUp: null, following: null, head: { walkedAt: NOW - SPACING, rowsPerPage: 12, contiguous: true,
    order: { verdict: 'unverified', pairs: 0, ordered: 0, at: 0 } }, ...over });
const inputs = (over: Partial<StepInputs> = {}): StepInputs => ({
  now: NOW, mode: 'session', light: false, launchAt: NOW - 1_000, checkSpacingMs: SPACING, clockToleranceMs: TOL,
  state: state(), lastHeaderAt: null, headerThisSweep: false, need: null,
  budget: { profiles: 1, notifications: 1, pages: 5, followingPages: 2 }, followingResidual: 0, feedGapThisSweep: false,
  planDayStartsAt: DAY_START, planDayKey: '2026-11-03', censusReadFollowingToday: false,
  autoAccept: true, acceptsAllowed: 3, activeRequestEdges: 0, ...over,
});

test('stale: unset, later than the clock allows, or older than the spacing', () => {
  expect(stale(null, NOW, SPACING, TOL)).toBe(true);
  expect(stale(NOW + TOL + 1, NOW, SPACING, TOL)).toBe(true);
  expect(stale(NOW + TOL, NOW, SPACING, TOL)).toBe(false);
  expect(stale(NOW - SPACING, NOW, SPACING, TOL)).toBe(true);
  expect(stale(NOW - SPACING + 1, NOW, SPACING, TOL)).toBe(false);
});

describe('the header (H)', () => {
  test('a check never visits; a session visits only when the header is stale; a launch always resolves it', () => {
    expect(decideStep('profile', inputs({ mode: 'check' }))).toMatchObject({ run: false, why: 'mode' });
    expect(decideStep('profile', inputs({ lastHeaderAt: NOW - 1 }))).toMatchObject({ run: false, why: 'fresh' });
    expect(decideStep('profile', inputs())).toMatchObject({ run: true });
    expect(decideStep('profile', inputs({ budget: { profiles: 0, notifications: 1, pages: 5, followingPages: 2 } })))
      .toMatchObject({ run: false, why: 'no-budget' });
    expect(decideStep('profile', inputs({ mode: 'launch', lastHeaderAt: NOW - 1 }))).toMatchObject({ run: true });
  });

  test('Boost keeps the session header (it feeds the ceiling)', () => {
    expect(decideStep('profile', inputs({ light: true }))).toMatchObject({ run: true });
  });
});

describe('the drawer (N) and its requests panel', () => {
  test('a fresh watermark skips the pass', () => {
    const feed = { atMs: 1, keysAtMs: [], readAt: NOW - 1, filteredAt: null, gap: null };
    expect(decideStep('notifications', inputs({ state: state({ feed }) }))).toMatchObject({ run: false, why: 'fresh' });
  });

  test('the panel never opens at launch', () => {
    expect(decideStep('notifications', inputs({ mode: 'launch' }))).toEqual({ id: 'notifications', run: true, panel: null });
  });

  test('accepts with the plan\'s allowance; without auto-accept, one verification read per plan-day', () => {
    expect(decideStep('notifications', inputs())).toMatchObject({ panel: { mode: 'accept', allowed: 3 } });
    expect(decideStep('notifications', inputs({ acceptsAllowed: 0 }))).toMatchObject({ panel: null });
    expect(decideStep('notifications', inputs({ autoAccept: false, activeRequestEdges: 2 }))).toMatchObject({ panel: { mode: 'verify' } });
    const verified = state({ requests: { observedAt: NOW, count: 2, complete: true, verifiedDayKey: '2026-11-03' } });
    expect(decideStep('notifications', inputs({ autoAccept: false, activeRequestEdges: 2, state: verified }))).toMatchObject({ panel: null });
    expect(decideStep('notifications', inputs({ autoAccept: false, activeRequestEdges: 0 }))).toMatchObject({ panel: null });
  });
});

describe('the followers head (L)', () => {
  const need = (unexplainedGains: number, identifiedSinceFrontier = 0) =>
    ({ identifiedSinceFrontier, unexplainedGains, rowsPerPage: 12, pagesAvailable: 5 });

  test('runs on unexplained gains this sweep\'s header saw, a feed gap, or no frontier; bounded by the frontier term', () => {
    expect(decideStep('followers-head', inputs({ headerThisSweep: true, need: need(3) }))).toMatchObject({ run: true, maxPages: 3 });
    expect(decideStep('followers-head', inputs({ headerThisSweep: false, need: need(3) }))).toMatchObject({ run: false, why: 'not-needed' });
    expect(decideStep('followers-head', inputs({ feedGapThisSweep: true }))).toMatchObject({ run: true });
    expect(decideStep('followers-head', inputs({ state: state({ head: null }) }))).toMatchObject({ run: true });
    expect(decideStep('followers-head', inputs({ headerThisSweep: true, need: need(500) }))).toMatchObject({ maxPages: 5 });
  });

  test('a check walks only on this sweep\'s gap; Boost defers it (the frontier keeps)', () => {
    expect(decideStep('followers-head', inputs({ mode: 'check', state: state({ head: null }) }))).toMatchObject({ run: false });
    expect(decideStep('followers-head', inputs({ mode: 'check', feedGapThisSweep: true }))).toMatchObject({ run: true });
    expect(decideStep('followers-head', inputs({ light: true, state: state({ head: null }) }))).toMatchObject({ run: false, why: 'boost' });
  });
});

describe('the following check (G)', () => {
  const due = { followingResidual: 2 };

  test('never at launch, never in a later check, never under Boost', () => {
    expect(decideStep('following', inputs({ ...due, mode: 'launch' }))).toMatchObject({ run: false, why: 'mode' });
    expect(decideStep('following', inputs({ ...due, mode: 'check' }))).toMatchObject({ run: false, why: 'mode' });
    expect(decideStep('following', inputs({ ...due, light: true }))).toMatchObject({ run: false, why: 'boost' });
  });

  test('a session runs it on a non-zero residual, at most once per plan-day, unless a census read the list today', () => {
    expect(decideStep('following', inputs(due))).toMatchObject({ run: true });
    expect(decideStep('following', inputs({ followingResidual: -1 }))).toMatchObject({ run: true });
    expect(decideStep('following', inputs())).toMatchObject({ run: false, why: 'not-needed' });
    const checked = state({ following: { checkedAt: DAY_START, count: 10, complete: true } });
    expect(decideStep('following', inputs({ ...due, state: checked }))).toMatchObject({ run: false, why: 'fresh' });
    expect(decideStep('following', inputs({ ...due, censusReadFollowingToday: true }))).toMatchObject({ run: false, why: 'fresh' });
    expect(decideStep('following', inputs({ ...due, budget: { profiles: 1, notifications: 1, pages: 5, followingPages: 0 } })))
      .toMatchObject({ run: false, why: 'no-budget' });
  });
});

test('the consistency step always runs', () => {
  for (const mode of ['launch', 'session', 'check'] as const) {
    expect(decideStep('consistency', inputs({ mode, light: true }))).toEqual({ id: 'consistency', run: true });
  }
});
