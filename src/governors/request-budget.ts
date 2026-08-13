import type { KnowledgeStore } from '../store/knowledge-store';
import type { Clock } from './clock';

export interface RequestBudgetConfig {
  maxRequestsPerWindow: number;
  windowMs: number;
}

/**
 * A global token-bucket over the durable `request_log` governing ALL Instagram
 * requests (reads and writes) in a rolling window — request volume is the primary
 * ban vector (§5).
 */
export class RequestBudget {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: Clock,
    private cfg: RequestBudgetConfig,
  ) {}

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: RequestBudgetConfig): void {
    this.cfg = cfg;
  }

  private usedInWindow(): number {
    return this.store.requestCountSince(this.clock.now() - this.cfg.windowMs);
  }

  /** Requests still available in the current rolling window, never below zero. */
  remaining(): number {
    return Math.max(0, this.cfg.maxRequestsPerWindow - this.usedInWindow());
  }

  /** True when at least one request may be spent now. */
  canSpend(): boolean {
    return this.usedInWindow() < this.cfg.maxRequestsPerWindow;
  }

  /** Record a request against the budget. */
  spend(): void {
    this.store.recordRequest(this.clock.now());
  }
}
