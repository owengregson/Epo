import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const REENTRY_POLICY = {
  reconcileAfterMs: HOUR,
  probationAfterMs: DAY,
  clockToleranceMs: 5 * 60_000,
  probationActions: 10,
  probationGapMs: 3 * 60_000,
} as const;

export interface ReentrySnapshot {
  v: 1;
  phase: 'reconcile' | 'probation' | 'ready';
  reason: 'new-install' | 'absence' | 'uncertain-effects' | 'clock-change' | 'legacy-state' | null;
  lastActiveAt: number | null;
  lastReconciledAt: number | null;
  reconciliationStartedAt: number | null;
  absentMs: number;
  probationActions: number;
  nextProbationActionAt: number | null;
  timezoneOffset: number;
}

type Reason = NonNullable<ReentrySnapshot['reason']>;
/** Returns whose per-record timers cannot be trusted, so every managed relationship is re-read. */
const CENSUS_REASONS: ReadonlySet<Reason> = new Set<Reason>(['clock-change', 'legacy-state']);

/** Restore knowledge before resuming decisions. Missed days never create action quota. */
export class ReentrySupervisor {
  private state: ReentrySnapshot;
  /** The deadline of the engine's current hold. In-process only: a restart cannot claim closed time. */
  private holdingUntil: number | null = null;
  private readonly store: Pick<KnowledgeStore,
    'getLifecycleState' | 'setLifecycleState' | 'activeFollowRecords' | 'pendingEffectIntents'>;
  private readonly clock: Clock;

  constructor(deps: { store: ReentrySupervisor['store']; clock: Clock }) {
    this.store = deps.store;
    this.clock = deps.clock;
    const now = this.clock.now();
    this.state = {
      v: 1, phase: 'ready', reason: 'new-install', lastActiveAt: null,
      lastReconciledAt: null, reconciliationStartedAt: null, absentMs: 0, probationActions: 0,
      nextProbationActionAt: null, timezoneOffset: new Date(now).getTimezoneOffset(),
    };
    const raw = this.store.getLifecycleState();
    if (raw !== null) {
      try {
        const s = JSON.parse(raw) as ReentrySnapshot;
        if (s.v === 1 && ['reconcile', 'probation', 'ready'].includes(s.phase)
          && (s.lastActiveAt === null || Number.isFinite(s.lastActiveAt))
          && (s.lastReconciledAt === null || Number.isFinite(s.lastReconciledAt))
          && (s.nextProbationActionAt === null || Number.isFinite(s.nextProbationActionAt))
          && Number.isFinite(s.absentMs) && Number.isFinite(s.probationActions)
          && s.absentMs >= 0 && Number.isSafeInteger(s.probationActions) && s.probationActions >= 0
          && Number.isFinite(s.timezoneOffset)) this.state = { ...s,
            reconciliationStartedAt: Number.isFinite(s.reconciliationStartedAt) ? s.reconciliationStartedAt
              : s.phase === 'reconcile' ? s.lastActiveAt ?? now : null };
        else throw new Error('Invalid durable reentry state');
      } catch {
        // Missing/corrupt history requires observation, never an invented successful recovery.
        this.state.reason = 'legacy-state';
        this.state.phase = 'reconcile';
      }
    }
  }

  prepare(now: number = this.clock.now()): ReentrySnapshot {
    const last = this.lastPresentAt(now);
    const gap = last === null ? 0 : now - last;
    let reason: ReentrySnapshot['reason'] = null;
    if (this.store.pendingEffectIntents().some((i) => i.state !== 'prepared')) reason = 'uncertain-effects';
    if (last === null && this.store.activeFollowRecords().length > 0) reason = 'legacy-state';
    if (gap > REENTRY_POLICY.reconcileAfterMs) reason = 'absence';
    if (gap < -REENTRY_POLICY.clockToleranceMs
      || new Date(now).getTimezoneOffset() !== this.state.timezoneOffset) reason = 'clock-change';
    if (reason !== null) {
      if (this.state.phase !== 'reconcile' || this.state.reconciliationStartedAt === null || reason === 'clock-change') {
        this.state.reconciliationStartedAt = now;
      }
      // A census still owed survives a later absence: only a completed census settles it.
      const owesCensus = this.state.phase === 'reconcile' && this.state.reason !== null && CENSUS_REASONS.has(this.state.reason);
      this.state.phase = 'reconcile';
      if (!owesCensus || CENSUS_REASONS.has(reason)) this.state.reason = reason;
      this.state.absentMs = Math.max(this.state.absentMs, Math.max(0, gap));
      this.state.probationActions = 0;
      this.state.nextProbationActionAt = null;
    }
    if (this.state.phase === 'reconcile' && this.state.reconciliationStartedAt === null) this.state.reconciliationStartedAt = now;
    this.state.timezoneOffset = new Date(now).getTimezoneOffset();
    this.state.lastActiveAt = now;
    this.persist();
    return this.snapshot();
  }

  requiresReconciliation(now: number = this.clock.now()): boolean {
    if (this.state.phase !== 'reconcile'
      && this.store.pendingEffectIntents().some((i) => i.state !== 'prepared')) this.prepare(now);
    const last = this.lastPresentAt(now);
    if (last !== null && (now - last > REENTRY_POLICY.reconcileAfterMs
      || now < last - REENTRY_POLICY.clockToleranceMs
      || new Date(now).getTimezoneOffset() !== this.state.timezoneOffset)) this.prepare(now);
    return this.state.phase === 'reconcile';
  }

  /**
   * Whether this return re-reads EVERY managed relationship. Only when the
   * per-record timers cannot be trusted (a clock change, history from before
   * the journal). An absence reconciles what its timers made due: the watcher
   * demands fresh evidence for each of those, and every mutation re-reads its
   * profile at the click. Live 2026-11-02 a census per return (one visit per
   * managed record) spent the whole read allowance before any growth.
   */
  requiresCensus(now: number = this.clock.now()): boolean {
    return this.requiresReconciliation(now) && this.state.reason !== null && CENSUS_REASONS.has(this.state.reason);
  }

  /**
   * The engine chose to stay idle until `until` (a session break, active
   * hours, a ceiling, a backoff). That is presence, not absence: the process
   * stays in control. Live 2026-11-02 an overnight session park counted as
   * "away", so every resume re-ran the return check and restarted probation.
   */
  holdUntil(until: number): void {
    this.holdingUntil = until;
  }

  /** The hold ended (elapsed or interrupted). Time PAST its deadline (a machine asleep) is still away. */
  endHold(now: number): void {
    const present = this.lastPresentAt(now);
    this.holdingUntil = null;
    if (present === null || present === this.state.lastActiveAt) return;
    this.state.lastActiveAt = present;
    this.persist();
  }

  noteReconciled(result: { outcome: 'complete' | 'partial' | 'failed' }, now: number): void {
    if (result.outcome !== 'complete') return;
    // The caller reconciles uncertain writes separately; a census cannot settle their ownership.
    if (this.store.pendingEffectIntents().some((i) => i.state !== 'prepared')) return;
    this.state.lastReconciledAt = now;
    this.state.lastActiveAt = now;
    // Routine successful sweeps cannot reset a return's owed probation gap or restart probation.
    if (this.state.phase === 'reconcile') {
      this.state.reconciliationStartedAt = null;
      this.state.phase = this.state.absentMs >= REENTRY_POLICY.probationAfterMs
        || this.state.reason === 'clock-change' || this.state.reason === 'legacy-state'
        ? 'probation' : 'ready';
      this.state.nextProbationActionAt = null;
      if (this.state.phase === 'ready') {
        this.state.absentMs = 0;
        this.state.reason = null;
      }
    }
    this.persist();
  }

  noteProgress(now: number): void {
    this.state.lastActiveAt = now;
    this.persist();
  }

  noteAction(now: number): void {
    this.state.lastActiveAt = now;
    if (this.state.phase === 'probation') {
      this.state.probationActions += 1;
      this.state.nextProbationActionAt = now + REENTRY_POLICY.probationGapMs;
      if (this.state.probationActions >= REENTRY_POLICY.probationActions) {
        this.state.phase = 'ready';
        this.state.absentMs = 0;
        this.state.reason = null;
      }
    }
    this.persist();
  }

  mutationWaitUntil(now: number): number | null {
    const at = this.state.nextProbationActionAt;
    return at !== null && at > now ? at : null;
  }

  snapshot(): ReentrySnapshot { return { ...this.state }; }
  private lastPresentAt(now: number): number | null {
    const last = this.state.lastActiveAt;
    if (last === null || this.holdingUntil === null) return last;
    return Math.max(last, Math.min(now, this.holdingUntil));
  }
  private persist(): void { this.store.setLifecycleState(JSON.stringify(this.state)); }
}
