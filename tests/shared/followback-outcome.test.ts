/**
 * The one follow-back classifier (spec §9.10): the class grid, including an undated follow-back
 * observed before the horizon, which counts as a success (U08 F12).
 */
import { followbackOutcome, type OutcomeRow } from '@/shared/followback-outcome';

const W = 1_000;
const row = (r: Partial<OutcomeRow>): OutcomeRow => ({
  state: 'pending_followback', followedAt: 0, followedBackAt: null, followbackAfter: null,
  followbackObservedAt: null, reconciledAt: null, unfollowReason: null, ...r,
});

test.each<[string, Partial<OutcomeRow>, number, ReturnType<typeof followbackOutcome>]>([
  ['no follow time', { followedAt: null, followedBackAt: 10 }, 5_000, 'excluded'],
  ['a follower before we followed', { followedBackAt: -5 }, 5_000, 'excluded'],
  ['a dated follow-back inside the window', { followedBackAt: 400 }, 5_000, 'success'],
  ['a dated follow-back exactly at the horizon', { followedBackAt: W }, 5_000, 'success'],
  ['an undated follow-back observed before the horizon', { followbackObservedAt: 900 }, 5_000, 'success'],
  ['a late follow-back', { followedBackAt: 1_500 }, 5_000, 'failure'],
  ['a follow-back bounded after the horizon', { followbackAfter: 1_200, followbackObservedAt: 1_600 }, 5_000, 'failure'],
  ['an undated follow-back straddling the horizon', { followbackObservedAt: 1_600 }, 5_000, 'censored'],
  ['no follow-back, read after the horizon', { reconciledAt: 1_200 }, 5_000, 'failure'],
  ['unfollowed for no follow-back', { state: 'unfollowed', unfollowReason: 'no-followback' }, 500, 'failure'],
  ['no follow-back and no read after the horizon', { reconciledAt: 900 }, 5_000, 'censored'],
  ['no follow-back yet, inside the window', {}, 500, 'pending'],
])('%s', (_name, r, now, expected) => {
  expect(followbackOutcome(row(r), W, now)).toBe(expected);
});

test('an unbounded window never fails a follow on time alone', () => {
  expect(followbackOutcome(row({ reconciledAt: 1e12 }), Number.POSITIVE_INFINITY, 2e12)).toBe('pending');
  expect(followbackOutcome(row({ followbackObservedAt: 1e12 }), Number.POSITIVE_INFINITY, 2e12)).toBe('success');
});
