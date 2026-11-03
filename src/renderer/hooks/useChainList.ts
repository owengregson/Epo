import { chainListSignal } from '@/renderer/app/live-signals';
import type { ChainTargetView, EpoStatus } from '@/types';

/**
 * Refetch key for the pull backstop behind the chain push: login and chain
 * position (target hop) PLUS the lifecycle counters, so any transition a status
 * push reports (a follow, a follow-back sweep, an unfollow coming due) re-pulls
 * the list even if a chain push were missed. Exported for the key-derivation
 * regression test; the shell's `useLiveFeeds` keys its backstop on it.
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

const NONE: ChainTargetView[] = [];

/**
 * The chain lineage (`chain:list`), live (docs/PRINCIPLES.md §2). The shell owns
 * the one subscription and its pull backstop (`useLiveFeeds`); this reads the
 * published list, so per-target yields tick DURING an acquisition walk wherever
 * the list is shown. Empty until the first pull lands.
 */
export function useChainList(): ChainTargetView[] {
  return chainListSignal.value ?? NONE;
}
