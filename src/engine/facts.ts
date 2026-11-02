/**
 * `Facts` — the snapshot every conductor rule decides over, and the sources that
 * gather it.
 *
 * A rule (see `rules.ts`) is a PURE function of a `Facts` slice: no `await`, no
 * store, no clock. Everything that has to touch the world to be known is a
 * {@link FactSource}, gathered ONCE per tick by the {@link FactGatherer} and
 * memoised — which is what makes "sample the clock once" a general property of
 * the runtime rather than a special gate (ADR 0902).
 *
 * Sources are gathered LAZILY, in rule order: a rule declares `needs`, and the
 * gatherer collects exactly those keys before calling `decide`. That is the
 * mechanism behind the loop's oldest safety guarantee — a superseded step never
 * reaches the sentinel, because nothing gathers `sentinel` until the `aborted`
 * rule has already declined to claim the tick.
 *
 * SEAM (wave B): `staleAfterMs` is honoured today but every source is per-tick
 * (`0`). Chronos-backed cadences and the ledger counts are the first groups that
 * will earn a real budget.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { FollowRecord } from '../store/types';
import type { ChurnActionOutcome } from './churn-scheduler';
import type { CurrentTarget } from './ports';
import type { RecoveryPhase } from './recovery';
import type { SourceVisitEndReason } from './source-frontier';

/** Which rule subset the conductor is running. Prune is a MODE, not an engine. */
export type Mode = 'growth' | 'prune-scan' | 'prune-run';

/** Per-tick context that is not a fact about the world (see `rules.ts`). */
export interface RunCtx {
  readonly mode: Mode;
}

/** A prune candidate as the woven feed hands it over. */
export interface FeedCandidate {
  pk: string;
  username: string;
}

/** Stop conditions that are true of the RUN, not of Instagram. */
export interface LifecycleFacts {
  /** This generation was stopped or replaced — the step must touch nothing. */
  aborted: boolean;
  /** The engine already halted; a step must not re-drive anything. */
  halted: boolean;
}

/** The instant every rule below the clock reads. Sampled once per tick. */
export interface ClockFacts {
  now: number;
}

/** The tab classification for this tick. */
export interface SentinelFacts {
  status: SentinelStatus;
}

/** The recovery ladder's live posture (`docs/adr/0201-recovery-ladder.md`). */
export interface RecoveryFacts {
  phase: RecoveryPhase;
  /** Ms of the armed hold still unserved; 0 when not holding. */
  holdRemainingMs: number;
}

/** The rate governor's counters — the ledger-backed half of the pacing verdict. */
export interface LedgerFacts {
  atHardCeiling: boolean;
  atOperatingRate: boolean;
  withinActiveHours: boolean;
  /** Ms until the action counter resets (the next cycle start). */
  msUntilCycleReset: number;
  /** Real IG actions (both ledgers) in the trailing hour. */
  actionsInLastHour: number;
}

/** The planner/settings half of the pacing verdict (see `pacers.ts`). */
export interface PacingFacts {
  /** Which model is wired — the presence of a planner, as a value. */
  model: 'organic' | 'legacy';
  sessionOpen: boolean;
  /** Only meaningful while `sessionOpen` is false. */
  nextSessionStartAt: number;
  hourlyVelocityCap: number;
  activeHoursStart: number;
}

/** The chain target the loop is working, once resolved. */
export interface TargetFacts {
  current: CurrentTarget | null;
}

/** The refill/chain decision inputs: how full the pool is and whether it can grow. */
export interface QueueFacts {
  queuedForTarget: number;
  lowWaterCandidates: number;
  targetExhausted: boolean;
  yieldToAction?: boolean;
  rotationReason?: SourceVisitEndReason | null;
  refillAvailableAt?: number;
}

/** A cadence that came due (persisted; §3 — evaluated at startup, not one interval later). */
export interface OverdueCadence {
  id: string;
  dueAt: number;
}

/** Due-by-timestamp work. */
export interface CadenceFacts {
  sweepDue: boolean;
  reconcile?: boolean;
  /**
   * Cadences whose deadline has passed. SEAM (wave B): fed by `chronos.due(now)`
   * before the first tick, so work that came due while the app was closed runs
   * first. Empty today — `sweepDue` is the only cadence the growth loop reads.
   */
  overdue: readonly OverdueCadence[];
}

/** The one-action-per-iteration decision inputs (ADR 0205). */
export interface ActionFacts {
  /** The lifecycle record whose timer is due, or null. */
  due: FollowRecord | null;
  /** The woven prune unfollow on offer, or null. */
  pruneCandidate: FeedCandidate | null;
  /**
   * The interleave draw, taken ONLY when both streams have work and the
   * lifecycle record is not itself an unfollow — drawn in the fact source so
   * `decide` stays pure and the seeded rng stream keeps its exact order.
   */
  weaveDraw: number | null;
  /** The interleave ceiling in force (settings ∧ the pattern cap). */
  unfollowFraction: number;
}

/** The consecutive-outcome windows the recovery ladder classifies on. */
export interface StreakFacts {
  failed: number;
  drift: number;
  blocked: number;
  lastBlockedCause: ChurnActionOutcome['cause'] | null;
  /** The failure count that enters the ladder from HERE (cold vs probing). */
  failingEntryThreshold: number;
}

/** The prune-mode candidate decision inputs (see `prune-candidate.ts`). */
export interface PruneFacts {
  /** The head of the census the run is draining, or null when spent. */
  candidate: { pk: string; username: string | null } | null;
  /** Whether the LIVE graph says this account follows us right now. */
  followsUsNow: boolean;
  /** The whitelist as it stands NOW — re-derived per candidate, never at scan time. */
  whitelist: readonly string[];
  atDailyCap: boolean;
}

/**
 * Every value the conductor's rules may read. Each key is one {@link FactSource};
 * a rule sees exactly the keys it declared in `needs`.
 */
export interface Facts {
  lifecycle: LifecycleFacts;
  clock: ClockFacts;
  sentinel: SentinelFacts;
  recovery: RecoveryFacts;
  ledger: LedgerFacts;
  pacing: PacingFacts;
  target: TargetFacts;
  queue: QueueFacts;
  cadence: CadenceFacts;
  action: ActionFacts;
  streaks: StreakFacts;
  prune: PruneFacts;
}

export type FactKey = keyof Facts;

/** Read another fact group from inside a source (memoised, cycle-free by construction). */
export type FactReader = <K extends FactKey>(key: K) => Promise<Facts[K]>;

export interface FactSource<K extends FactKey> {
  /**
   * How long a gathered value stays fresh, in ms. `0` = this tick only, which is
   * every source today. A positive budget lets a value survive across ticks.
   */
  readonly staleAfterMs: number;
  gather(read: FactReader): Promise<Facts[K]> | Facts[K];
}

/** The sources an owner registers. A rule needing an unregistered key is a loud error. */
export type FactSources = Partial<{ [K in FactKey]: FactSource<K> }>;

/**
 * Gathers declared facts once per tick, honouring each source's staleness
 * budget. Never caches an in-flight failure: a rejected `gather` propagates and
 * the entry stays absent, so the next tick re-reads rather than serving a
 * fabricated value (PRINCIPLES: no silent catches).
 */
export class FactGatherer {
  private readonly sources: FactSources;
  private readonly clock: Clock;
  private readonly cache = new Map<FactKey, { at: number; value: unknown }>();

  constructor(sources: FactSources, clock: Clock) {
    this.sources = sources;
    this.clock = clock;
  }

  /** Open a new tick: every per-tick entry is dropped; budgeted ones age normally. */
  beginTick(): void {
    for (const key of [...this.cache.keys()]) {
      if ((this.sources[key]?.staleAfterMs ?? 0) === 0) this.cache.delete(key);
    }
  }

  /** Drop one entry (an effect invalidated it mid-tick). */
  invalidate(key: FactKey): void {
    this.cache.delete(key);
  }

  read: FactReader = async <K extends FactKey>(key: K): Promise<Facts[K]> => {
    const source = this.sources[key];
    if (source === undefined) {
      throw new Error(`facts: no source registered for '${key}'`);
    }
    const hit = this.cache.get(key);
    const now = this.clock.now();
    if (hit !== undefined && (source.staleAfterMs === 0 || now - hit.at <= source.staleAfterMs)) {
      return hit.value as Facts[K];
    }
    const value = await source.gather(this.read);
    this.cache.set(key, { at: now, value });
    return value;
  };

  /**
   * Collect exactly `needs`, in declaration order. The result carries ONLY those
   * keys — a rule that reads an undeclared fact gets `undefined`, which
   * `tests/engine/rules.test.ts` turns into a thrown error.
   */
  async collect(needs: readonly FactKey[]): Promise<Partial<Facts>> {
    const out: Partial<Facts> = {};
    for (const key of needs) {
      // Assigning through a narrowed key keeps the map homogeneous without a cast
      // per key; the loop is sequential on purpose (sources may read each other).
      (out as Record<string, unknown>)[key] = await this.read(key);
    }
    return out;
  }
}
