import { startOfLocalDay } from '../timing/units';
import type { CurrentTarget, EngineDeps, EnginePacing } from './ports';
import type { RuntimeHealth } from './runtime-health';

export function projectEngineStatus(deps: EngineDeps, target: CurrentTarget | null, pacingPlanner: EnginePacing | undefined, health: RuntimeHealth) {
    const { store, rate, clock } = deps;
    const chainIndex =
      target === null
        ? null
        : (store.getTarget(target.pk)?.chainIndex ?? null);
    const startOfToday = startOfLocalDay(clock.now());
    const pnow = clock.now();
    const pacing = pacingPlanner
      ? {
          sessionOpen: pacingPlanner.isSessionOpen(pnow),
          sessionEndsAt: pacingPlanner.sessionEndsAt(pnow),
          nextSessionAt: pacingPlanner.isSessionOpen(pnow)
            ? null
            : pacingPlanner.nextSessionStartAt(pnow),
          sessionsToday: pacingPlanner.sessionsToday(pnow),
          dailyTarget: pacingPlanner.dailyTarget(pnow),
        }
      : null;
    return {
      health: health.snapshot(),
      frontier: deps.frontier?.snapshot(),
      reentry: deps.reentry?.snapshot(),
      currentTargetPk: target?.pk ?? null,
      currentTargetUsername: target?.username ?? null,
      chainIndex,
      actionsToday: rate.actionsToday(),
      remainingToday: rate.remainingToday(),
      plannedToday: rate.plannedToday(),
      atHardCeiling: rate.atHardCeiling(),
      queued: store.followRecordsByState('queued').length,
      pendingFollowback: store.followRecordsByState('pending_followback').length,
      followedBackHeld: store.followRecordsByState('followed_back').length,
      unfollowDue: store.followRecordsByState('unfollow_queued').length,
      netToday: store.netFollowersSince(startOfToday),
      pacing,
    };
}

export function projectRecovery(recovery: import('./recovery').RecoverySupervisor): import('./status').EngineStatus['recovery'] {
    const phase = recovery.phase();
    if (phase === 'holding') {
      return {
        phase: 'holding',
        attempt: recovery.attemptNow(),
        maxAttempts: recovery.maxAttempts(),
        resumeAt: recovery.holdDeadline(),
      };
    }
    if (phase === 'probing') {
      return {
        phase: 'probing',
        attempt: recovery.attemptNow(),
        maxAttempts: recovery.maxAttempts(),
        resumeAt: null,
      };
    }
    return null;
}
