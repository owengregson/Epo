import type { PlanView } from '../governors/plan-types';
import { startOfLocalDay } from '../timing/units';
import type { CurrentTarget, EngineDeps, EnginePacing } from './ports';
import type { RuntimeHealth } from './runtime-health';

/** The deprecated session readout the old renderer shows, read from the plan's pure view. */
function sessionReadout(view: PlanView) {
  const open = view.open;
  return {
    sessionOpen: open !== null,
    sessionEndsAt: open === null ? null : (view.sessions[open.idx]?.closesAt ?? null),
    nextSessionAt: open === null ? view.nextSessionAt : null,
    sessionsToday: view.plan.sessions.filter((s) => s.budget > 0).length,
    dailyTarget: view.plan.volume.planned,
  };
}

export function projectEngineStatus(deps: EngineDeps, target: CurrentTarget | null, plan: EnginePacing | undefined, health: RuntimeHealth) {
    const { store, rate, clock } = deps;
    const chainIndex =
      target === null
        ? null
        : (store.getTarget(target.pk)?.chainIndex ?? null);
    const startOfToday = startOfLocalDay(clock.now());
    const pacing = plan === undefined ? null : sessionReadout(plan.view(clock.now()));
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
