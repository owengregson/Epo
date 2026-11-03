import type { PlanDayClock } from '../kernel/plan';
import { automaticDayMax } from '../kernel/plan/volume';
import type { KnowledgeStore } from '../store/knowledge-store';
import { actionGap } from '../timing/action-gap';
import { sample } from '../timing/primitives';
import { MS_PER_HOUR } from '../timing/units';
import { launchStream } from '../utils/entropy';
import type { Clock } from './clock';
import { calendarPlanDayClock } from './plan-day-clock';

export interface RateGovernorConfig {
  dailyHardCeiling: number;
  dailyOperatingRate: number;
  minDelayMs: number;
  maxDelayMs: number;
  jitterPercent: number;
  activeHoursStart: number;
  activeHoursEnd: number;
}

/** The plan the governor counts against (the plan service in production; spec §5.13 S1). */
export interface RatePlan {
  /** The one plan-day boundary every day counter reads. */
  readonly day: PlanDayClock;
  /** The plan-day's automatic volume V (today's law, spec §5.4) and the automatic work it still holds (§5.7). */
  volume(now: number): { readonly planned: number; readonly remaining: number };
}

/**
 * Enforces the durable daily action cap. Every count comes from the store's
 * `action_ledger`, so limits survive restart (fixing the old in-memory-cap bug).
 * The day is the plan's: its boundary and its volume. With no plan wired the day
 * is the calendar's and the volume its automatic-day maximum.
 */
export class RateGovernor {
  private readonly day: PlanDayClock;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: Clock,
    private cfg: RateGovernorConfig,
    private readonly rng: () => number = launchStream('governors/rate-governor'),
    private readonly plan: RatePlan | null = null,
  ) {
    this.day = plan?.day ?? calendarPlanDayClock({ now: () => clock.now() });
  }

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: RateGovernorConfig): void {
    this.cfg = cfg;
  }

  /** The current plan-day's start: the one boundary every day counter shares (spec §4.4). */
  dayStart(now: number = this.clock.now()): number {
    return this.day.window(now).startsAt;
  }

  /** The plan-day start under the name the prune engine and the store reads still use. */
  cycleStartMs(now: number = this.clock.now()): number {
    return this.dayStart(now);
  }

  /** ms until the NEXT plan-day starts — when {@link actionsToday} resets. */
  msUntilCycleReset(now: number = this.clock.now()): number {
    return Math.max(1, this.day.window(now).endsAt - now);
  }

  /**
   * Durable count of REAL Instagram actions recorded in the CURRENT plan-day,
   * across BOTH ledgers (growth's action_ledger + prune's ok/fail rows) and the
   * unsettled intents — the account has one write budget, whichever driver
   * spends it. Survives restart.
   */
  actionsToday(): number {
    const since = this.dayStart();
    return this.store.actionCountSince(since) + this.store.realPruneActionCountSince(since)
      + this.store.additionalMutationCountSince(since);
  }

  /**
   * The automatic volume the plan holds for today: a plan-day draw under the
   * operating rate, so the amount done per day fluctuates instead of landing on
   * the configured number. The hard ceiling stays the fixed limit.
   */
  plannedToday(): number {
    return this.plan?.volume(this.clock.now()).planned ?? automaticDayMax(this.cfg.dailyOperatingRate);
  }

  /** The automatic work left today: the plan's own remainder, never below zero. */
  remainingToday(): number {
    if (this.plan !== null) return this.plan.volume(this.clock.now()).remaining;
    return Math.max(0, this.plannedToday() - this.actionsToday());
  }

  /**
   * Real IG actions (both ledgers) in the trailing hour — the durable, restart-safe
   * velocity signal the engine gates on as a ledger-backed net.
   */
  actionsInLastHour(now: number = this.clock.now()): number {
    const since = now - MS_PER_HOUR;
    return this.store.actionCountSince(since) + this.store.realPruneActionCountSince(since)
      + this.store.additionalMutationCountSince(since);
  }

  /**
   * True once today's actions reach the plan's automatic volume. The engine
   * treats this as "done for today"; the hard ceiling below stays the
   * uncrossable backstop with headroom for manual actions.
   */
  atOperatingRate(): boolean {
    return this.actionsToday() >= this.plannedToday();
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
   * symmetric ± jitter of `jitterPercent`. Equal bounds with zero jitter receive
   * positive-only variation, so an exact configured interval stays the minimum.
   * `rng` is injectable for deterministic tests.
   */
  nextDelayMs(rng: () => number = this.rng): number {
    const { minDelayMs, maxDelayMs, jitterPercent } = this.cfg;
    return sample(actionGap(minDelayMs, maxDelayMs, jitterPercent), rng);
  }
}
