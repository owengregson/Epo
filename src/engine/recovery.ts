/**
 * RecoverySupervisor — the growth engine's classified, durable recovery ladder.
 *
 * Replaces the terminal `actions-failing` halt (and the invisible blocked-retry
 * loop) with a three-rung escalation: when actions stop landing, the engine
 * diagnoses the tab FIRST (a sick tab gets recovered, consuming no rung), then
 * presumes a rate wall and serves a long jittered hold; after each hold the
 * next real actions ARE the probe. Three failed rungs end in an honest
 * `recovery-exhausted` halt; confirmed interface drift short-circuits to
 * `adapter-drift` — waiting cannot fix a reshaped page.
 *
 * This class is the PURE state machine (inactive → holding(n) → probing →
 * exhausted): it owns the rung count, the hold draws, the failure-kind tally,
 * and the durable snapshot (store meta `recovery_state`, §3 — a relaunch
 * mid-hold serves the REMAINDER of the absolute deadline). The Engine owns
 * everything live: diagnosis, the actual wait (via the DelayManager), halting,
 * and status projection. Fully fake-clock testable — no timers, no browser.
 */

import type { Clock } from '../governors/clock';
import { RECOVERY } from '../timing/config';
import { clamp, logNormal } from '../timing/distributions';
import { type Rng, sample } from '../timing/primitives';
import * as log from '../utils/logger';

/** The failure families the ladder classifies entries into. */
export type FailureKind = 'rate-limited' | 'tab-unhealthy' | 'drift' | 'auth' | 'network';

/**
 * Where the ladder stands. `diagnosing` is transient (never persisted — the
 * Engine moves through it within one step); `holding` carries an absolute
 * `holdUntil`; `probing` means a hold elapsed and the next real actions decide;
 * `exhausted` means every rung failed and the Engine has halted.
 */
export type RecoveryPhase = 'inactive' | 'diagnosing' | 'holding' | 'probing' | 'exhausted';

/** The store slice the supervisor persists through (KnowledgeStore satisfies it). */
export interface RecoveryStateStore {
  getRecoveryState(): string | null;
  setRecoveryState(raw: string | null): void;
  setRecoveryLastIncident(raw: string | null): void;
}

/**
 * A CLOSED systemic-incident window: the ladder ran (so actions were failing
 * systemically) and then reset (a probe succeeded, or the user acked a
 * terminal halt with a fresh Start) — the proof that the window
 * [enteredAt, resolvedAt] was systemic-and-over. Persisted as store meta
 * `recovery_last_incident` at the reset moment and handed to the Engine, whose
 * requeue-healer uses it to give the records the window burned their one
 * second chance. `healed` is null until the healer has run; the Engine amends
 * the persisted record with the outcome.
 */
export interface RecoveryIncident {
  /** When the ladder was first entered (its first hold began). */
  enteredAt: number;
  /** When the ladder reset — the window's proven end. */
  resolvedAt: number;
  /** Rungs the episode consumed. */
  attempts: number;
  /** The episode's failure-kind tally (diagnostics). */
  kindTally: Partial<Record<FailureKind, number>>;
  /** The requeue-healer's outcome, amended in by the Engine after healing. */
  healed: { count: number; at: number } | null;
}

/** The durable snapshot shape (meta key `recovery_state`). */
export interface RecoverySnapshot {
  phase: RecoveryPhase;
  attempt: number;
  holdUntil: number | null;
  enteredAt: number | null;
  kindTally: Partial<Record<FailureKind, number>>;
}

export interface RecoverySupervisorDeps {
  clock: Clock;
  store: RecoveryStateStore;
  /** Randomness for the hold draws; injectable for deterministic tests. */
  rng?: Rng;
}

export class RecoverySupervisor {
  private readonly clock: Clock;
  private readonly store: RecoveryStateStore;
  private readonly rng: Rng;

  private phaseNow: RecoveryPhase = 'inactive';
  /** Rungs BEGUN so far (1-based while a hold is armed or being probed). */
  private attempt = 0;
  /** Absolute deadline of the armed hold; null outside `holding`. */
  private holdUntil: number | null = null;
  /** When the ladder was first entered (this episode); null when inactive. */
  private enteredAt: number | null = null;
  /** How many entries each failure kind contributed (diagnostics + drift evidence). */
  private kindTally: Partial<Record<FailureKind, number>> = {};
  /** What `diagnosing` restores to when the entry routes to tab recovery. */
  private priorPhase: 'inactive' | 'probing' = 'inactive';

  constructor(deps: RecoverySupervisorDeps) {
    this.clock = deps.clock;
    this.store = deps.store;
    this.rng = deps.rng ?? Math.random;
    this.hydrate(deps.store.getRecoveryState());
  }

  // --- Read side --------------------------------------------------------------

  phase(): RecoveryPhase {
    return this.phaseNow;
  }

  attemptNow(): number {
    return this.attempt;
  }

  maxAttempts(): number {
    return RECOVERY.MAX_HOLDS;
  }

  /** The armed hold's absolute deadline, or null when not holding. */
  holdDeadline(): number | null {
    return this.phaseNow === 'holding' ? this.holdUntil : null;
  }

  /** Ms of the armed hold still unserved at `now` (0 when none / already past). */
  holdRemainingMs(now: number): number {
    if (this.phaseNow !== 'holding' || this.holdUntil === null) return 0;
    return Math.max(0, this.holdUntil - now);
  }

  /** The failure-kind tally (for the halt-time diagnostic bundle). */
  tally(): Partial<Record<FailureKind, number>> {
    return { ...this.kindTally };
  }

  /**
   * The consecutive-failure count that ENTERS (or re-enters) the ladder:
   * `coldThreshold` (ACTIONS_FAILING_HALT) from a standing start, but only
   * {@link RECOVERY.REENTRY_FAILS} while a served hold is being probed — each
   * failed rung burns ~2 ledger rows, never another full cold window.
   */
  failingEntryThreshold(coldThreshold: number): number {
    return this.phaseNow === 'probing' ? RECOVERY.REENTRY_FAILS : coldThreshold;
  }

  /**
   * Whether accumulated evidence CONFIRMS drift: at least two independent
   * drift-classified windows AND at least one served hold (the owner directive:
   * ambiguity defaults to rate-limited for the first hold; only repeated,
   * definitive drift evidence short-circuits to the drift terminal).
   */
  driftConfirmed(): boolean {
    return (this.kindTally.drift ?? 0) >= 2 && this.attempt >= 1;
  }

  // --- Transitions ------------------------------------------------------------

  /**
   * Record a classified failure signal at ladder entry (or a tab-recovery note
   * from the watchdog). Pure tallying — no phase change. Persisted only while
   * the ladder is live, so `inactive` keeps its state-is-null invariant.
   */
  noteOutcome(kind: FailureKind): void {
    this.kindTally[kind] = (this.kindTally[kind] ?? 0) + 1;
    if (this.phaseNow !== 'inactive') this.persist();
  }

  /**
   * Enter the TRANSIENT diagnosing phase (never persisted): the Engine runs
   * the tab probes under it and either arms a hold ({@link beginHold}) or
   * routes to tab recovery ({@link abortDiagnosis} — no rung consumed).
   */
  beginDiagnosis(): void {
    if (this.phaseNow === 'inactive' || this.phaseNow === 'probing') {
      this.priorPhase = this.phaseNow;
      this.phaseNow = 'diagnosing';
    }
  }

  /** Diagnosis routed elsewhere (tab recovery / terminal): restore the prior phase. */
  abortDiagnosis(): void {
    if (this.phaseNow === 'diagnosing') this.phaseNow = this.priorPhase;
  }

  /**
   * Begin the next rung's hold at `now`: draws its duration, arms the absolute
   * deadline, and persists. Returns `null` when every rung is spent — the
   * ladder latches `exhausted` and the caller halts (`recovery-exhausted`).
   */
  beginHold(now: number = this.clock.now()): { attempt: number; holdMs: number } | null {
    if (this.attempt >= RECOVERY.MAX_HOLDS) {
      this.phaseNow = 'exhausted';
      this.persist();
      return null;
    }
    this.attempt += 1;
    if (this.enteredAt === null) this.enteredAt = now;
    const holdMs = this.nextHoldMs();
    this.holdUntil = now + holdMs;
    this.phaseNow = 'holding';
    this.persist();
    return { attempt: this.attempt, holdMs };
  }

  /**
   * Draw the CURRENT rung's hold duration: log-normal around the rung's median,
   * clamped to [{@link RECOVERY.HOLD_MIN_FACTOR}, {@link RECOVERY.HOLD_MAX_FACTOR}]
   * × median (the same jitter pattern as the engine's velocity park — bounded,
   * never a fixed period).
   */
  nextHoldMs(): number {
    const medians = RECOVERY.HOLD_MEDIANS_MS;
    const rung = Math.min(Math.max(this.attempt, 1), medians.length);
    const median = medians[rung - 1];
    return sample(
      clamp(
        logNormal(median, RECOVERY.HOLD_SIGMA),
        median * RECOVERY.HOLD_MIN_FACTOR,
        median * RECOVERY.HOLD_MAX_FACTOR,
      ),
      this.rng,
    );
  }

  /** The armed hold's deadline was fully served: the ladder moves to probing. */
  completeHold(): void {
    if (this.phaseNow !== 'holding') return;
    this.phaseNow = 'probing';
    this.holdUntil = null;
    this.persist();
  }

  /**
   * A verified ok/simulated outcome landed: the machinery works again. Clears
   * the whole ladder (attempt, tally, persisted state). No-op (null) when
   * inactive; otherwise returns the closed incident window (see {@link reset}).
   */
  noteRecovered(): RecoveryIncident | null {
    if (this.phaseNow === 'inactive') return null;
    log.info('recovery: probe succeeded — ladder cleared', {
      attempt: this.attempt,
      tally: this.kindTally,
    });
    return this.reset();
  }

  /**
   * Clear everything — user ack (a manual Start from a recovery halt) or
   * success. The reset moment is the PROOF that the episode's failure window
   * was systemic-and-over, so when an episode was actually live (a hold began
   * — `enteredAt` is stamped) the closed window [enteredAt, resolvedAt=now] is
   * persisted as the last incident (store meta `recovery_last_incident`) and
   * returned for the Engine's requeue-healer. A reset with no live episode
   * (nothing entered, or a hydrated snapshot that lost its enteredAt) returns
   * null — no honest window exists, so nothing may be healed off it.
   */
  reset(): RecoveryIncident | null {
    const incident: RecoveryIncident | null =
      this.enteredAt === null
        ? null
        : {
            enteredAt: this.enteredAt,
            resolvedAt: this.clock.now(),
            attempts: this.attempt,
            kindTally: { ...this.kindTally },
            healed: null,
          };
    this.phaseNow = 'inactive';
    this.attempt = 0;
    this.holdUntil = null;
    this.enteredAt = null;
    this.kindTally = {};
    this.store.setRecoveryState(null);
    if (incident !== null) {
      this.store.setRecoveryLastIncident(JSON.stringify(incident));
      log.info('recovery: incident window closed', {
        enteredAt: incident.enteredAt,
        resolvedAt: incident.resolvedAt,
        attempts: incident.attempts,
      });
    }
    return incident;
  }

  // --- Durability (§3) ----------------------------------------------------------

  serialize(): RecoverySnapshot {
    return {
      phase: this.phaseNow,
      attempt: this.attempt,
      holdUntil: this.holdUntil,
      enteredAt: this.enteredAt,
      kindTally: { ...this.kindTally },
    };
  }

  /**
   * Hydrate from a persisted snapshot (defensive: bad JSON or an impossible
   * shape logs and stays inactive — never a crash, never a fabricated hold).
   * A persisted transient `diagnosing` collapses to inactive; a `holding` whose
   * deadline already passed is kept — the engine's serve step sees a zero
   * remainder and moves straight to probing (relaunch-after-deadline probes
   * immediately).
   */
  private hydrate(raw: string | null): void {
    if (raw === null) return;
    try {
      const snap = JSON.parse(raw) as Partial<RecoverySnapshot>;
      const phase = snap.phase;
      if (phase !== 'holding' && phase !== 'probing' && phase !== 'exhausted') return;
      const attempt = typeof snap.attempt === 'number' && snap.attempt > 0 ? snap.attempt : 0;
      if (attempt === 0) return;
      this.phaseNow = phase;
      this.attempt = Math.min(attempt, RECOVERY.MAX_HOLDS);
      this.holdUntil =
        phase === 'holding' && typeof snap.holdUntil === 'number' ? snap.holdUntil : null;
      if (phase === 'holding' && this.holdUntil === null) {
        // A hold with no deadline is unservable — degrade to probing.
        this.phaseNow = 'probing';
      }
      this.enteredAt = typeof snap.enteredAt === 'number' ? snap.enteredAt : null;
      this.kindTally =
        typeof snap.kindTally === 'object' && snap.kindTally !== null
          ? { ...snap.kindTally }
          : {};
      log.info('recovery: ladder state hydrated', {
        phase: this.phaseNow,
        attempt: this.attempt,
        holdUntil: this.holdUntil,
      });
    } catch (e) {
      log.warn('recovery: bad persisted state, starting inactive', { error: String(e) });
    }
  }

  private persist(): void {
    this.store.setRecoveryState(JSON.stringify(this.serialize()));
  }
}
