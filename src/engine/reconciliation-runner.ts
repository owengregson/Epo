import { ENGINE } from '../timing/config';
import type { EngineDeps } from './ports';

export type ReconciliationStep =
  | { outcome: 'complete' | 'aborted' | 'halt' }
  | { outcome: 'wait'; delayMs: number };

/** Bounded observation batches are progress; only failed observations consume retries. */
export class ReconciliationRunner {
  private failures = 0;
  constructor(private readonly deps: Pick<EngineDeps,
    'clock' | 'reentry' | 'reconcileEffects' | 'followback'>) {}

  async run(now: number, aborted: () => boolean): Promise<ReconciliationStep> {
    const fresh = this.deps.reentry?.requiresReconciliation(now) ?? false;
    const raw = await this.deps.reconcileEffects?.() ?? true;
    if (aborted()) return { outcome: 'aborted' };
    const effects = typeof raw === 'boolean' ? { outcome: raw ? 'complete' : 'failed' } as const : raw;
    if (effects.outcome === 'progress') {
      this.failures = 0;
      return { outcome: 'wait', delayMs: ENGINE.IDLE_MS };
    }
    if (effects.outcome === 'deferred') return this.defer('retryAt' in effects ? effects.retryAt : undefined);
    if (effects.outcome === 'failed') return this.failure();
    const result = await this.deps.followback.check({ requireFresh: fresh,
      freshSinceAt: this.deps.reentry?.snapshot().reconciliationStartedAt ?? undefined });
    if (aborted()) return { outcome: 'aborted' };
    if (result.deferred) {
      if (result.deferred === 'reconciliation-progress') this.failures = 0;
      return this.defer(result.retryAt);
    }
    if ((result.outcome ?? 'complete') !== 'complete') return this.failure();
    this.failures = 0;
    this.deps.reentry?.noteReconciled({ outcome: 'complete' }, this.deps.clock.now());
    // Request acceptance may itself have produced a new uncertain effect during the read.
    if (this.deps.reentry?.requiresReconciliation(this.deps.clock.now())) return this.defer(this.deps.clock.now() + ENGINE.IDLE_MS);
    return { outcome: 'complete' };
  }

  private defer(retryAt?: number): ReconciliationStep {
    return { outcome: 'wait', delayMs: Math.max(ENGINE.IDLE_MS,
      (retryAt ?? this.deps.clock.now() + ENGINE.ENRICH_BACKOFF_MS) - this.deps.clock.now()) };
  }
  private failure(): ReconciliationStep {
    return ++this.failures >= 5 ? { outcome: 'halt' }
      : { outcome: 'wait', delayMs: ENGINE.ENRICH_BACKOFF_MS };
  }
}
