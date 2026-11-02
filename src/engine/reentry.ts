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

/** Restore knowledge before resuming decisions. Missed days never create action quota. */
export class ReentrySupervisor {
  private state: ReentrySnapshot;
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
    const last = this.state.lastActiveAt;
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
      this.state.phase = 'reconcile';
      this.state.reason = reason;
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
    const last = this.state.lastActiveAt;
    if (last !== null && (now - last > REENTRY_POLICY.reconcileAfterMs
      || now < last - REENTRY_POLICY.clockToleranceMs
      || new Date(now).getTimezoneOffset() !== this.state.timezoneOffset)) this.prepare(now);
    return this.state.phase === 'reconcile';
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
  private persist(): void { this.store.setLifecycleState(JSON.stringify(this.state)); }
}
