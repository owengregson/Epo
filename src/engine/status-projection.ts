/**
 * The engine's status projection: PURE reads of the store, the governors and the plan's view —
 * nothing here writes. "Today" is the plan-day (spec §4.4).
 */

import type { PlanView } from '../governors/plan-types';
import type { CurrentTarget, EngineDeps, EnginePacing } from './ports';
import type { RuntimeHealth } from './runtime-health';

/** The day's automatic volume: the current plan, including a Boost lift or a lowered target. */
const dayVolume = (view: PlanView): number => view.plan.volume.planned;

export function projectEngineStatus(deps: EngineDeps, target: CurrentTarget | null, plan: EnginePacing, health: RuntimeHealth) {
    const { store, rate, clock } = deps;
    const chainIndex =
      target === null
        ? null
        : (store.getTarget(target.pk)?.chainIndex ?? null);
    const view = plan.view(clock.now());
    const quality = deps.frontier?.qualityEnabled() ? deps.frontier.qualityView() : null;
    return {
      health: health.snapshot(),
      frontier: deps.frontier?.snapshot(),
      candidateQuality: quality === null ? undefined : {
        readyCandidates: quality.qualifiedSources.reduce((sum, pk) => sum + (quality.counts.get(pk) ?? 0), 0),
        requiredCandidates: quality.readyCount,
        preparingCandidates: target === null ? 0 : (quality.counts.get(target.pk) ?? 0),
        needsReset: quality.needsReset,
      },
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
