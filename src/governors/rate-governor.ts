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

  /**
   * The moment the CURRENT active-hours cycle began: the most recent occurrence
   * of `activeHoursStart` o'clock. The daily budget belongs to an active-hours
   * CYCLE, not the calendar day — an overnight window's post-midnight tail
   * (e.g. 11→3: work done at 00:30) keeps counting against the cycle it belongs
   * to, and the counter resets the moment a fresh window opens instead of at
   * midnight. A degenerate `start === end` window falls back to local midnight.
   */
  cycleStartMs(now: number = this.clock.now()): number {
    const { activeHoursStart: start, activeHoursEnd: end } = this.cfg;
    if (start === end) return startOfLocalDay(now);
    const d = new Date(now);
    d.setHours(start, 0, 0, 0);
    if (d.getTime() > now) {
      // The start hour hasn't arrived yet today — the cycle opened yesterday.
      d.setDate(d.getDate() - 1);
      d.setHours(start, 0, 0, 0); // re-normalize across a DST-shifted date change
    }
    return d.getTime();
  }

  /** ms until the NEXT cycle start — when {@link actionsToday} resets. */
  msUntilCycleReset(now: number = this.clock.now()): number {
    const { activeHoursStart: start, activeHoursEnd: end } = this.cfg;
    const d = new Date(this.cycleStartMs(now));
    d.setDate(d.getDate() + 1);
    d.setHours(start === end ? 0 : start, 0, 0, 0);
    return Math.max(1, d.getTime() - now);
  }

  /**
   * Durable count of REAL Instagram actions recorded in the CURRENT active-hours
   * cycle (see {@link cycleStartMs}), across BOTH ledgers (growth's
   * action_ledger + prune's ok/fail rows) — the account has one write budget,
   * whichever driver spends it. Survives restart.
   */
  actionsToday(): number {
    const since = this.cycleStartMs();
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
