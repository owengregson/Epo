/**
 * The engine's status projection: PURE reads of the store, the governors and the plan's view —
 * nothing here writes. "Today" is the plan-day (spec §4.4); `pacing` is the deprecated session
 * readout the old renderer still shows (`status.plan` replaces it).
 */

import type { PlanView } from '../governors/plan-types';
import type { CurrentTarget, EngineDeps, EnginePacing } from './ports';
import type { RuntimeHealth } from './runtime-health';

/** The day's automatic volume: what the day law drew, or more once a Boost lifted it. */
const dayVolume = (view: PlanView): number => Math.max(view.plan.volume.drawn, view.plan.volume.planned);

/** The deprecated session readout the old renderer shows, read from the plan's pure view. */
function sessionReadout(view: PlanView) {
  const open = view.open;
  return {
    sessionOpen: open !== null,
    sessionEndsAt: open === null ? null : (view.sessions[open.idx]?.closesAt ?? null),
    nextSessionAt: open === null ? view.nextSessionAt : null,
    sessionsToday: view.plan.sessions.filter((s) => s.budget > 0).length,
    dailyTarget: dayVolume(view),
  };
}

export function projectEngineStatus(deps: EngineDeps, target: CurrentTarget | null, plan: EnginePacing, health: RuntimeHealth) {
    const { store, rate, clock } = deps;
    const chainIndex =
      target === null
        ? null
        : (store.getTarget(target.pk)?.chainIndex ?? null);
    const view = plan.view(clock.now());
    return {
      health: health.snapshot(),
      frontier: deps.frontier?.snapshot(),
      currentTargetPk: target?.pk ?? null,
      currentTargetUsername: target?.username ?? null,
      chainIndex,
      actionsToday: rate.actionsToday(),
      remainingToday: view.remaining,
      plannedToday: dayVolume(view),
      atHardCeiling: rate.atHardCeiling(),
      queued: store.followRecordsByState('queued').length,
      pendingFollowback: store.followRecordsByState('pending_followback').length,
      followedBackHeld: store.followRecordsByState('followed_back').length,
      unfollowDue: store.followRecordsByState('unfollow_queued').length,
      netToday: store.netFollowersSince(view.window.startsAt),
      pacing: sessionReadout(view),
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
