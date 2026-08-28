import { useEffect, useState } from 'preact/hooks';
import type { ChainTargetView, EpoStatus } from '@/types';

/**
 * Refetch key for the belt-and-braces pull in {@link useChainList}: login and
 * chain position (target hop) PLUS the lifecycle counters, so any transition a
 * status push reports (a follow, a follow-back sweep, an unfollow coming due)
 * re-pulls the list even if a chain push were missed. Exported for the
 * key-derivation regression test.
 */
export function chainListKey(status: EpoStatus | null): string {
  if (status === null) return '';
  return [
    status.loggedIn ? 1 : 0,
    status.currentTargetPk ?? '',
    status.chainIndex ?? '',
    status.queued,
    status.pendingFollowback,
    status.followedBackHeld,
    status.unfollowDue,
    status.actionsToday,
  ].join('|');
}

/**
 * The chain lineage (`chain:list`), live (§2). Primary source: the pushed
 * `chainList` projection, re-shaped in main on every store mutation (throttled)
 * — this is what makes per-target yields tick DURING an acquisition walk, where
 * observations write accounts/edges only and no status counter moves. A pull
 * keyed on {@link chainListKey} backstops it: initial load before any push, and
 * every lifecycle transition the status stream reports.
 */
export function useChainList(status: EpoStatus | null): ChainTargetView[] {
  const [list, setList] = useState<ChainTargetView[]>([]);

  useEffect(() => {
    const onPush = (l: ChainTargetView[]): void => setList(l);
    window.epo.on('chainList', onPush);
    return () => window.epo.off('chainList', onPush);
  }, []);

  const key = chainListKey(status);
  useEffect(() => {
    let alive = true;
    window.epo
      .chainList()
      .then((l) => {
        if (alive) setList(l);
      })
      .catch(() => {
        /* foundation logs; keep the last good list */
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return list;
}
