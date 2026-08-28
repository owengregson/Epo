/**
 * `chainListKey` — the belt-and-braces refetch key behind `useChainList`.
 *
 * The pushed `chainList` projection is the primary live source (§2); the pull
 * keyed here backstops it. The key must move on every lifecycle transition the
 * status stream reports (follow performed, follow-back swept, unfollow due) —
 * not only at a chain hop, which historically happened weeks apart and left
 * the Now Targeting yields frozen at their launch values.
 */
import { chainListKey } from '@/renderer/hooks/useChainList';
import type { EpoStatus } from '@/types';

const base = {
  loggedIn: true,
  currentTargetPk: '777',
  chainIndex: 2,
  queued: 10,
  pendingFollowback: 4,
  followedBackHeld: 3,
  unfollowDue: 1,
  actionsToday: 7,
  remainingToday: 18,
  lastStep: 'acted',
  nextActionAt: 123456,
} as unknown as EpoStatus;

const withPatch = (patch: Partial<EpoStatus>): EpoStatus => ({ ...base, ...patch });

describe('chainListKey', () => {
  test('is stable for an identical status', () => {
    expect(chainListKey(withPatch({}))).toBe(chainListKey(base));
  });

  test('changes when `queued` changes (a follow moved a record through the lifecycle)', () => {
    expect(chainListKey(withPatch({ queued: 9 }))).not.toBe(chainListKey(base));
  });

  test('changes on every other lifecycle counter and on a chain hop', () => {
    const variants: Partial<EpoStatus>[] = [
      { pendingFollowback: 5 },
      { followedBackHeld: 2 },
      { unfollowDue: 0 },
      { actionsToday: 8 },
      { chainIndex: 3 },
      { currentTargetPk: '999' },
      { loggedIn: false },
    ];
    for (const patch of variants) {
      expect(chainListKey(withPatch(patch))).not.toBe(chainListKey(base));
    }
  });

  test('ignores churn that says nothing about the chain (no refetch storms)', () => {
    expect(chainListKey(withPatch({ remainingToday: 17 }))).toBe(chainListKey(base));
    expect(chainListKey(withPatch({ nextActionAt: 999999 }))).toBe(chainListKey(base));
  });

  test('null status keys distinctly (pre-first-status render)', () => {
    expect(chainListKey(null)).toBe('');
    expect(chainListKey(null)).not.toBe(chainListKey(base));
  });
});
