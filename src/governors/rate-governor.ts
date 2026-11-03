import type { PlanDayClock } from '../kernel/plan';
import type { KnowledgeStore } from '../store/knowledge-store';
import { MS_PER_HOUR } from '../timing/units';
import type { Clock } from './clock';
import { calendarPlanDayClock } from './plan-day-clock';

export interface RateGovernorConfig {
  dailyHardCeiling: number;
}

/** The plan the governor counts against (the plan service in production; spec §5.13). */
export interface RatePlan {
  /** The one plan-day boundary every day counter reads. */
  readonly day: PlanDayClock;
}

/**
 * The durable write counters (spec §5.13 S2): every count comes from the store's
 * ledgers and unsettled intents, so limits survive restart. The day is the plan's
 * boundary (the calendar's with no plan wired); the plan decides the pace and the
 * volume, the governor only counts and holds the uncrossable hard ceiling.
 */
export class RateGovernor {
  private readonly day: PlanDayClock;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly clock: Clock,
    private cfg: RateGovernorConfig,
    plan: RatePlan | null = null,
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
   * Real IG actions (both ledgers) in the trailing hour — the durable, restart-safe
   * velocity signal the engine gates on as a ledger-backed net.
   */
  actionsInLastHour(now: number = this.clock.now()): number {
    const since = now - MS_PER_HOUR;
    return this.store.actionCountSince(since) + this.store.realPruneActionCountSince(since)
      + this.store.additionalMutationCountSince(since);
  }

  /** True once today's actions reach the hard ceiling (uncrossable in code). */
  atHardCeiling(): boolean {
    return this.actionsToday() >= this.cfg.dailyHardCeiling;
  }
}
