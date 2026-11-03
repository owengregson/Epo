/**
 * The unconfirmed-actions breaker (ADR 0308, spec §11.1 F7): one stall is not a wall, a streak is.
 * Each kind counts its consecutive dispatched writes Instagram answered with nothing. At
 * `driftConfirmThreshold()` that kind waits out the rest of the session it tripped in (the plan mix
 * offers none, the admission refuses `unconfirmed`); the next session allows one attempt, and a streak
 * at `blockedStreakThreshold()` enters the recovery ladder. Any confirmed write of the kind resets it.
 */

import { blockedStreakThreshold, driftConfirmThreshold } from '../kernel/derive';
import type { EngineWriteKind } from './plan-port';

/** The kind held back and its streak (the `actionsUnconfirmed` status field's shape). */
export interface UnconfirmedHold {
  readonly kind: EngineWriteKind;
  readonly streak: number;
}

/** The breaker's state, in memory per graph: a restart opens a fresh window, like the churn's streaks. */
export class UnconfirmedBreaker {
  private streaks: Record<EngineWriteKind, number> = { follow: 0, unfollow: 0 };
  /** Until when the tripped kind is held (the next session's start, or the plan-day's end). */
  private hold: { kind: EngineWriteKind; until: number } | null = null;

  /** Record one dispatched write's evidence at `at` (a trip holds the kind until `holdUntil`); returns its streak. */
  note(kind: EngineWriteKind, unverified: boolean, at: number, holdUntil: number): number {
    if (!unverified) {
      this.streaks[kind] = 0;
      if (this.hold?.kind === kind) this.hold = null;
      return 0;
    }
    const streak = this.streaks[kind] + 1;
    this.streaks[kind] = streak;
    if (streak >= driftConfirmThreshold() && holdUntil > at) this.hold = { kind, until: holdUntil };
    return streak;
  }

  /** The kind held at `now`, with its streak; null once the hold has passed (the next session's one attempt). */
  held(now: number): UnconfirmedHold | null {
    const h = this.hold;
    if (h === null || now >= h.until) return null;
    return { kind: h.kind, streak: this.streaks[h.kind] };
  }

  /** Whether a streak of this size enters the recovery ladder (the third unverified at the reference). */
  static entersLadder(streak: number): boolean {
    return streak >= blockedStreakThreshold();
  }
}
