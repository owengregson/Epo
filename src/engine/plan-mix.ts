/**
 * The plan's mix (ADR 0607, spec §5.7): which one action the tick takes, decided inside the `action`
 * fact source from the open session's kind budgets. It asks the churn for the best due unfollow and the
 * best queued follow, applies the plan's admission, and draws `u('mix', s, k)` against the session's
 * unfollow share; it emits the existing action shape, so `pickAction` and the rules are untouched.
 */

import type { PlanView } from '../governors/plan-types';
import type { MutationKind, Writer } from '../kernel/plan';
import { RECOVERY } from '../timing/config';
import type { ActionFacts, FeedCandidate } from './facts';
import { isRateLimitHaltKey } from './halt-reason';
import type { EngineChurn } from './ports';

/** The last halt and the ladder's posture: what the cleanup cool-down reads. */
export interface CooldownFacts {
  readonly lastHalt: { readonly reason: string; readonly at: number } | null;
  readonly ladder: { readonly phase: string; readonly kindTally: Readonly<Record<string, number | undefined>> };
}

/**
 * The cleanup cool-down after a rate wall (spec §5.7, §17.3): woven and run cleanup wait out a
 * rate-limit halt's window and any live ladder that has classified a rate-limited failure.
 */
export function cleanupCooldown(f: CooldownFacts, now: number): boolean {
  const halt = f.lastHalt;
  if (halt !== null && isRateLimitHaltKey(halt.reason) && now - halt.at < RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS) return true;
  return (f.ladder.phase === 'holding' || f.ladder.phase === 'probing') && (f.ladder.kindTally['rate-limited'] ?? 0) > 0;
}

/** What the mix reads at the tick's instant. */
export interface MixInputs {
  readonly view: PlanView;
  readonly churn: Pick<EngineChurn, 'nextDue'>;
  /** The woven feed's next offer (the census minus its leading skips), or null. */
  readonly woven: () => FeedCandidate | null;
  /** The surface gate's pause of unfollows (spec §10.6). */
  readonly unfollowsPaused: boolean;
  /** The cleanup cool-down after a rate wall (woven cleanup only). */
  readonly cooldown: boolean;
}

/** An admission the action step itself serves (the owed deadline) counts as admitted for the choice. */
function admitted(view: PlanView, kind: MutationKind, writer: Writer): boolean {
  const a = view.admits(kind, writer);
  return a.ok || a.reason === 'deadline';
}

const NONE: ActionFacts = { due: null, pruneCandidate: null, weaveDraw: null, unfollowFraction: 0 };

/**
 * The tick's one action (spec §5.7): a due lifecycle unfollow first among unfollows, woven cleanup only when
 * none is due; follows and unfollows mixed by the session's shares; an unfollow never takes a follow's
 * budget, a follow may take an idle unfollow share. Unfollow work is unavailable under Boost, the
 * unconfirmed-actions breaker or a spent kind (the admission), a paused surface, or the cool-down (woven).
 */
export function planMix(m: MixInputs, now: number): ActionFacts {
  const { view } = m;
  const open = view.open;
  if (open === null) return NONE;
  const followRec = admitted(view, 'follow', 'growth') ? m.churn.nextDue(now, 'follow') : null;
  const unfollowsOpen = !m.unfollowsPaused && open.mixLeft.unfollow > 0;
  const lifecycle = unfollowsOpen && admitted(view, 'unfollow', 'growth') ? m.churn.nextDue(now, 'unfollow') : null;
  const woven = unfollowsOpen && lifecycle === null && !m.cooldown && admitted(view, 'unfollow', 'woven') ? m.woven() : null;
  const unfollow = lifecycle !== null || woven !== null;
  if (followRec !== null && unfollow) {
    const left = open.mixLeft;
    const draw = view.mixDraw(view.sessions[open.idx]?.used ?? 0);
    const share = left.unfollow / Math.max(1, left.follow + left.unfollow);
    if (draw !== null && draw >= share) return { ...NONE, due: followRec };
  }
  if (lifecycle !== null) return { ...NONE, due: lifecycle };
  if (woven !== null) return { ...NONE, pruneCandidate: woven };
  return followRec === null ? NONE : { ...NONE, due: followRec };
}
