import type { KnowledgeStore } from '../store/knowledge-store';
import { jittered, sample } from '../timing/primitives';
import { startOfLocalDay } from '../timing/units';
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
    return startOfLocalDay(this.clock.now());
  }

  /**
   * Durable count of REAL Instagram actions recorded since local midnight,
   * across BOTH ledgers (growth's action_ledger + prune's ok/fail rows) — the
   * account has one write budget, whichever driver spends it. Survives restart.
   */
  actionsToday(): number {
    const since = this.startOfTodayLocal();
    return this.store.actionCountSince(since) + this.store.realPruneActionCountSince(since);
  }

  /** Operating-rate headroom left today, never below zero. */
  remainingToday(): number {
    return Math.max(0, this.cfg.dailyOperatingRate - this.actionsToday());
  }

  /**
   * Real IG actions (both ledgers) in the trailing hour — the durable, restart-safe
   * velocity signal. The organic pacing model is velocity-sensitive (detection keys on
   * actions/minute, not just actions/day), so the engine gates on this independently of
   * the planner's in-memory ring as a second, ledger-backed net.
   */
  actionsInLastHour(now: number = this.clock.now()): number {
    const since = now - 3_600_000;
    return this.store.actionCountSince(since) + this.store.realPruneActionCountSince(since);
  }

  /**
   * True once today's actions reach the user's operating rate — the rate the
   * engine is ADVERTISED to pace itself to. The engine treats this as "done for
   * today" (parks to midnight); the hard ceiling below stays the uncrossable
   * backstop with headroom for manual actions.
   */
  atOperatingRate(): boolean {
    return this.actionsToday() >= this.cfg.dailyOperatingRate;
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
   * A paced delay before the next action: a base uniformly in [min,max], then a
   * symmetric ± jitter of `jitterPercent` (the canonical `jittered` policy from
   * timing/primitives — written exactly once for the whole app). `rng` is
   * injectable for deterministic tests.
   */
  nextDelayMs(rng: () => number = Math.random): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(jittered(minDelayMs, maxDelayMs, jitterPercent), rng);
  }
}
