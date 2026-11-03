import type { Clock } from '../governors/clock';
import type { RateGovernor } from '../governors/rate-governor';
import type { ParkSlots } from '../kernel/derive-parks';
import type { ClickVerdict } from '../shared/click-verdict';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord, FollowState } from '../store/types';
import type { ProtectionPort } from './protection-port';

/**
 * The discriminated outcome of a single follow/unfollow attempt:
 *
 * - `'ok'`        — the click was performed and the Actor verified the transition.
 * - `'failed'`    — a click was attempted but did not confirm (retry/abandon).
 * - `'blocked'`   — Sentinel non-`ok` BEFORE any click; the
 *                   record is left completely untouched so it retries when the
 *                   window clears. A block is NOT a failure.
 * - `'simulated'` — dry-run: no click happened. The lifecycle STATE still advances
 *                   (so dry-run exercises the machine) but no real edge/ledger row
 *                   is written, so dry-run never pollutes yield/overlap.
 * - `'reviewed'`  — the click review consumed the work with `verdict` (spec §9.7); nothing pressed.
 */
export type ChurnActionOutcome = {
  status: 'ok' | 'failed' | 'blocked' | 'simulated' | 'reviewed';
  /** The click review's verdict when `'reviewed'`; a local-policy block's `deferred` reason and until. */
  verdict?: ClickVerdict;
  /** True when `ok` but no click happened — the button was already in the target
   *  state, so an external actor is responsible for the relationship. */
  alreadyInState?: boolean;
  /**
   * Why a non-ok outcome happened, when the cause is classifiable:
   *  - `'tab-unhealthy'` — the TAB stalled or its webContents was unavailable
   *    (status `'blocked'`: record-neutral — never a retry, never a fail row;
   *    the recovery ladder routes it to tab recovery, not the wait ladder).
   *  - `'drift'` — an `AdapterStaleError`: the expected control is gone
   *    (status `'failed'`; feeds the ladder's drift-evidence tally).
   *  - `'rate-limited'` — Instagram's SERVER refused the mutation as
   *    throttling (`feedback_required` / 429 in the response; status
   *    `'blocked'`: record-neutral, but DEFINITIVE — the engines back off at
   *    once instead of proving a blocked streak against the wall).
   * Absent when the cause is unknown or ordinary.
   */
  cause?: 'tab-unhealthy' | 'drift' | 'rate-limited' | 'local-policy';
  /**
   * True when a tab failure landed AFTER the click was dispatched but BEFORE
   * post-state verification — the action may have LANDED on Instagram. The
   * scheduler keeps a durable uncertain intent for read-only reconciliation.
   * A later observed state does not prove the historical action was ours.
   */
  unverifiedClick?: boolean;
};

/**
 * The only Instagram-touching surface the scheduler needs. The real implementation
 * wraps Actor + Sentinel; tests pass a fake that records calls and
 * returns a configurable outcome. Both methods resolve (never reject) with a
 * {@link ChurnActionOutcome} so an outcome is a value, not a thrown exception — but
 * the scheduler still guards against rejections defensively (no silent catches;
 * failures are logged).
 */
export interface ChurnActions {
  follow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<ChurnActionOutcome>;
  unfollow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<ChurnActionOutcome>;
}

/**
 * Lifecycle timers + retry cap for the churn state machine, projected from Settings
 * by `toChurnConfig` (tests build it from `tests/kit/configs.ts`).
 */
export interface ChurnConfig {
  /** How long to wait for a follow-back before reclaiming the slot. */
  maxWaitForFollowbackMs: number;
  /** The hold a follow-back first seen at the click earns (the re-held verdict, spec §9.7). */
  holdAfterFollowbackMs: number;
  /** Failed follow/unfollow attempts tolerated before a record is abandoned. */
  maxRetries: number;
  /** False = "keep people who follow you back": a held mutual is never rotated out (spec §6.4, P2 off). */
  rotateMutuals: boolean;
}

/** What one verb does to a record and the graph when its action verifies. */
export interface VerbSpec {
  /** The follows-edge polarity a verified action leaves behind. */
  edge: boolean;
  /** The lifecycle state a verified action lands in. */
  next: FollowState;
  /** Whether the transition stamps `followedAt`. */
  stampsFollowedAt: boolean;
  /** Whether an EXTERNAL already-in-state result also closes the record. */
  closeOnExternal: boolean;
}

/** Injected collaborators — no browser, no globals, so the scheduler is unit-testable. */
export interface ChurnDeps {
  store: KnowledgeStore;
  clock: Clock;
  rate: RateGovernor;
  actions: ChurnActions;
  /** Our own account `pk`; when set, follow/unfollow are recorded as directed edges. */
  ownPk?: string;
  cfg: ChurnConfig;
  pickQueued?: (records: FollowRecord[]) => FollowRecord | null;
  validateFollow?: (rec: FollowRecord, now: number) => Promise<boolean> | boolean;
  /** Whether `pk` has a follow request in flight (the requester seam); defaults to never. */
  hasActiveRequest?: (pk: string) => boolean;
  /** The protection port (spec §7.4); a rig without it runs unconfigured (main always wires it). */
  protection?: ProtectionPort;
  /** Re-judges the kept records (spec §7.5); synced before every selection pass and on a reload. */
  reconciler?: { sync(now: number): unknown };
  /** Where a click-time park lands (default: local-midnight plan-days; main hands the wiring's). */
  parkSlots?(): ParkSlots;
  /** The open session's start and planned unfollows: the bound on reviews that press nothing (spec §9.7). */
  reviewBound?(now: number): { readonly since: number; readonly planned: number } | null;
}
