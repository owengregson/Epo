import type { EpoStatus } from '@/types';

/** The chain push's pull-backstop key includes lifecycle counters, so missed pushes cannot freeze the list. */
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
