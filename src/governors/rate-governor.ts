import type { KnowledgeStore } from '../store/knowledge-store';
import { jittered, sample } from '../timing/primitives';
import type { Clock } from './clock';

export interface RateGovernorConfig {
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  minDelayMs: number;
  maxDelayMs: number;
  jitterPercent: number;
  activeHoursStart: number;
  activeHoursEnd: number;
}

/**
 * Enforces the durable daily action cap. Every count comes from the store's
 * `action_ledger`, so limits survive restart (fixing the old in-memory-cap bug).
 */
export class RateGovernor {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: Clock,
    private cfg: RateGovernorConfig,
  ) {}

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: RateGovernorConfig): void {
    this.cfg = cfg;
  }

  /** Local midnight of the clock's current day. */
  private startOfTodayLocal(): number {
    const d = new Date(this.clock.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** Durable count of actions recorded since local midnight (survives restart). */
  actionsToday(): number {
    return this.store.actionCountSince(this.startOfTodayLocal());
  }

  /** Operating-rate headroom left today, never below zero. */
  remainingToday(): number {
    return Math.max(0, this.cfg.dailyOperatingRate - this.actionsToday());
  }

  /** True once today's actions reach the hard ceiling (uncrossable in code). */
  atHardCeiling(): boolean {
    return this.actionsToday() >= this.cfg.dailyHardCeiling;
  }

  /**
   * True when the clock's local hour is inside the configured active window.
   *
   * f13 — supports OVERNIGHT (wrapping) windows where `start > end` (e.g. 22→6):
   * the hour is inside when `hour >= start OR hour < end`. The normal same-day case
   * (`start <= end`, e.g. 9→17) keeps the plain `start <= hour < end` test. A
   * degenerate `start === end` window is treated as never active.
   */
  withinActiveHours(): boolean {
    const hour = new Date(this.clock.now()).getHours();
    const { activeHoursStart: start, activeHoursEnd: end } = this.cfg;
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    // Wrapping window: active from `start` through midnight and on until `end`.
    return hour >= start || hour < end;
  }

  /**
   * A humanized delay before the next action: a base uniformly in [min,max], then a
   * symmetric ± jitter of `jitterPercent` (the canonical `jittered` policy from
   * timing/primitives — written exactly once for the whole app). `rng` is
   * injectable for deterministic tests.
   */
  nextDelayMs(rng: () => number = Math.random): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(jittered(minDelayMs, maxDelayMs, jitterPercent), rng);
  }
}
