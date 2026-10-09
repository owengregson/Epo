/**
 * The growth conductor's fact sources: everything a rule may read, and the ONLY
 * place the runtime touches the world before a verdict is decided.
 *
 * Kept beside the Engine rather than inside it so the table is readable on its
 * own — and so the ordering each source depends on is documented next to the
 * source, not buried in a 1,100-line class. Each is per-tick
 * (`staleAfterMs: 0`); wave B gives the ledger and the cadences real budgets and
 * feeds `cadence.overdue` from `chronos.due(now)`.
 *
 * Sources are gathered LAZILY, in rule order (see `facts.ts`), which is what
 * keeps the loop's oldest guarantees true without an ordering comment: a
 * superseded step never reaches the sentinel, and the clock is sampled once.
 */

import type { SentinelStatus } from '../adapter/sentinel';
import type { Clock } from '../governors/clock';
import type { Settings } from '../settings/settings';
import type { KnowledgeStore } from '../store/knowledge-store';
import { PATTERN } from '../timing/config';
import { MS_PER_HOUR } from '../timing/units';
import { queuedCountFor } from './decisions';
import type { FactSources, FeedCandidate } from './facts';
import type {
  CurrentTarget,
  EngineChurn,
  EnginePacing,
  EngineRate,
  EngineSentinel,
  SweepCadence,
} from './ports';
import type { RecoveryPhase } from './recovery';

/** The recovery-ladder slice the fact sources read (RecoverySupervisor satisfies it). */
export interface FactRecovery {
  phase(): RecoveryPhase;
  holdRemainingMs(now: number): number;
  failingEntryThreshold(coldThreshold: number): number;
}

/** The target-pipeline slice the fact sources read (TargetPipeline satisfies it). */
export interface FactTargets {
  readonly current: CurrentTarget | null;
  adoptActiveTargetFromStore(): boolean;
  isExhausted(): boolean;
}

/** Everything the sources need, as narrow reads — no Engine instance. */
export interface EngineFactDeps {
  clock: Clock;
  rate: EngineRate;
  store: KnowledgeStore;
  churn: EngineChurn;
  sentinel: EngineSentinel;
  /** Live settings (swapped between steps). */
  settings(): Settings;
  /** This generation was stopped or replaced. */
  aborted(): boolean;
  halted(): boolean;
  /** Record the tick's sentinel reading on the owner (status projection). */
  onSentinel(status: SentinelStatus): void;
  recovery: FactRecovery;
  /** The organic planner, or undefined in the legacy model. */
  pacing?: EnginePacing;
  targets: FactTargets;
  sweepCadence: SweepCadence;
  /** The woven prune feed's next offer (consumes leading skips — see the Engine). */
  selectPruneCandidate(now: number): FeedCandidate | null;
  /** The seeded engine stream (never the noise stream). */
  rng(): number;
  /** The cold consecutive-failure threshold the ladder enters at. */
  actionsFailingHalt: number;
}

export function buildEngineFactSources(d: EngineFactDeps): FactSources {
  const { clock, rate, store } = d;
  return {
    lifecycle: {
      staleAfterMs: 0,
      gather: () => ({ aborted: d.aborted(), halted: d.halted() }),
    },

    // Sample the clock ONCE: every rule below reads THIS instant.
    clock: { staleAfterMs: 0, gather: () => ({ now: clock.now() }) },

    sentinel: {
      staleAfterMs: 0,
      gather: async () => {
        const status = await d.sentinel.check();
        d.onSentinel(status);
        return { status };
      },
    },

    recovery: {
      staleAfterMs: 0,
      gather: () => ({
        phase: d.recovery.phase(),
        holdRemainingMs: d.recovery.holdRemainingMs(clock.now()),
      }),
    },

    ledger: {
      staleAfterMs: 0,
      gather: () => ({
        atHardCeiling: rate.atHardCeiling(),
        atOperatingRate: rate.atOperatingRate(),
        withinActiveHours: rate.withinActiveHours(),
        msUntilCycleReset: rate.msUntilCycleReset(),
        actionsInLastHour: rate.actionsInLastHour(),
      }),
    },

    pacing: {
      staleAfterMs: 0,
      gather: async (read) => {
        const { now } = await read('clock');
        const settings = d.settings();
        const planner = d.pacing;
        if (planner === undefined) {
          return {
            model: 'legacy' as const,
            sessionOpen: true,
            nextSessionStartAt: now,
            hourlyVelocityCap: settings.hourlyVelocityCap,
            activeHoursStart: settings.activeHoursStart,
          };
        }
        // The planner's own clock advances only when the hard ceiling is not
        // already closing the day — a ceiling park must not consume session
        // time it never used.
        const { atHardCeiling } = await read('ledger');
        if (!atHardCeiling) planner.advance(now);
        const sessionOpen = planner.isSessionOpen(now);
        return {
          model: 'organic' as const,
          sessionOpen,
          nextSessionStartAt: sessionOpen ? now : planner.nextSessionStartAt(now),
          hourlyVelocityCap: settings.hourlyVelocityCap,
          activeHoursStart: settings.activeHoursStart,
        };
      },
    },

    target: {
      staleAfterMs: 0,
      gather: async (read) => {
        const { now } = await read('clock');
        // Cheap timer transitions first: no IG traffic, and the churn
        // scheduler's due set is what the action source reads below.
        d.churn.advanceTimers(now);
        // Adopting the store's ACTIVE front is free; a null here means there is
        // nothing to adopt and the seed must be bootstrapped (an acquisition,
        // so it costs the step).
        if (d.targets.current === null) d.targets.adoptActiveTargetFromStore();
        return { current: d.targets.current };
      },
    },

    queue: {
      staleAfterMs: 0,
      gather: async (read) => {
        const target = (await read('target')).current;
        return {
          queuedForTarget: target === null ? 0 : queuedCountFor(store, target.pk),
          lowWaterCandidates: d.settings().lowWaterCandidates,
          targetExhausted: d.targets.isExhausted(),
        };
      },
    },

    cadence: {
      staleAfterMs: 0,
      gather: async (read) => {
        const { now } = await read('clock');
        return {
          sweepDue: d.sweepCadence.isDue(now, d.settings().followbackSweepHours * MS_PER_HOUR),
          // SEAM (wave B): `chronos.due(now)` fills this before the first tick.
          overdue: [],
        };
      },
    },

    action: {
      staleAfterMs: 0,
      gather: async (read) => {
        const { now } = await read('clock');
        const due = d.churn.nextDue(now);
        const pruneCandidate = d.selectPruneCandidate(now);
        const unfollowFraction = Math.min(
          d.settings().maxUnfollowFractionPerSession,
          PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION,
        );
        // The interleave draw is taken HERE — exactly when both streams have
        // work and the lifecycle record is not itself an unfollow — so the
        // decision stays pure and the seeded stream keeps its order.
        const weaveDraw =
          due !== null && pruneCandidate !== null && due.state !== 'unfollow_queued'
            ? d.rng()
            : null;
        return { due, pruneCandidate, weaveDraw, unfollowFraction };
      },
    },

    streaks: {
      staleAfterMs: 0,
      gather: () => {
        const { failed, drift, blocked } = d.churn.streaks();
        return {
          failed,
          drift,
          blocked,
          lastBlockedCause: d.churn.lastBlockedCause() ?? null,
          failingEntryThreshold: d.recovery.failingEntryThreshold(d.actionsFailingHalt),
        };
      },
    },
  };
}
