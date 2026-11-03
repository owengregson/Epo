import { ENGINE } from '../timing/config';
import type { EngineDeps } from './ports';

export type ReconciliationStep =
  /** `progress`: a bounded batch observed something — continue at the next step. */
  | { outcome: 'complete' | 'aborted' | 'halt' | 'progress' }
  /**
   * `read-budget`: the allowance reopens at a KNOWN time, so the wait is a
   * schedule, not a retry. Live 2026-11-02 the retry park's 0.5–2× noise
   * stretched an 11.5 h budget wait to 19.9 h. `backoff`: a failed read.
   */
  | { outcome: 'wait'; delayMs: number; reason: 'read-budget' | 'backoff' };

/**
 * Bounded observation batches are progress; only failed observations consume
 * retries. Progress CONTINUES without a park: the shared profile visitor paces
 * every read, and parking after each batch of ten made a burst-then-stop rhythm
 * (live 2026-11-02, "checking relationships after N days away").
 */
export class ReconciliationRunner {
  private failures = 0;
  constructor(private readonly deps: Pick<EngineDeps,
    'clock' | 'reentry' | 'reconcileEffects' | 'followback'>) {}

  async run(now: number, aborted: () => boolean): Promise<ReconciliationStep> {
    // An absence reconciles what its timers made due; only untrusted timers re-read everyone.
    const census = this.deps.reentry?.requiresCensus(now) ?? false;
    const raw = await this.deps.reconcileEffects?.() ?? true;
    if (aborted()) return { outcome: 'aborted' };
    const effects = typeof raw === 'boolean' ? { outcome: raw ? 'complete' : 'failed' } as const : raw;
    if (effects.outcome === 'progress') {
      this.failures = 0;
      return { outcome: 'progress' };
    }
    if (effects.outcome === 'deferred') return this.defer('retryAt' in effects ? effects.retryAt : undefined,
      'retryAt' in effects && effects.retryAt !== undefined ? 'read-budget' : 'backoff');
    if (effects.outcome === 'failed') return this.failure();
    const result = await this.deps.followback.check({ requireFresh: census,
      freshSinceAt: this.deps.reentry?.snapshot().reconciliationStartedAt ?? undefined });
    if (aborted()) return { outcome: 'aborted' };
    if (result.deferred === 'reconciliation-progress') {
      this.failures = 0;
      return { outcome: 'progress' };
    }
    if (result.deferred) return this.defer(result.retryAt, result.deferred === 'read-budget' ? 'read-budget' : 'backoff');
    if ((result.outcome ?? 'complete') !== 'complete') return this.failure();
    this.failures = 0;
    this.deps.reentry?.noteReconciled({ outcome: 'complete' }, this.deps.clock.now());
    // Request acceptance may itself have produced a new uncertain effect during the read.
    if (this.deps.reentry?.requiresReconciliation(this.deps.clock.now())) return this.defer(this.deps.clock.now() + ENGINE.IDLE_MS);
    return { outcome: 'complete' };
  }

  private defer(retryAt?: number, reason: 'read-budget' | 'backoff' = 'backoff'): ReconciliationStep {
    return { outcome: 'wait', reason, delayMs: Math.max(ENGINE.IDLE_MS,
      (retryAt ?? this.deps.clock.now() + ENGINE.ENRICH_BACKOFF_MS) - this.deps.clock.now()) };
  }
  private failure(): ReconciliationStep {
    return ++this.failures >= 5 ? { outcome: 'halt' }
      : { outcome: 'wait', delayMs: ENGINE.ENRICH_BACKOFF_MS, reason: 'backoff' };
  }
}
