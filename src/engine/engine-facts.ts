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
import { queuedCountFor } from './decisions';
import { EXPLORATION_POLICY } from './exploration-policy';
import type { FactSources, FeedCandidate } from './facts';
import { sweepDue } from './facts-cadence';
import { journalDue } from './facts-journal';
import { actionSource, pacingSource } from './facts-plan';
import type {
  CurrentTarget,
  EngineChurn,
  EnginePacing,
  EngineRate,
  EngineSentinel,
  SweepCadence,
} from './ports';
import type { RecoveryPhase } from './recovery';
import type { SourceVisitEndReason } from './source-frontier';

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
  /** The plan: the one pacing model. */
  pacing: EnginePacing;
  targets: FactTargets;
  sweepCadence: SweepCadence;
  /** The woven prune feed's next offer (consumes leading skips — see the Engine). */
  selectPruneCandidate(now: number): FeedCandidate | null;
  /** The cleanup cool-down after a rate wall (spec §5.7). */
  cleanupCooldown(now: number): boolean;
  /** The cold consecutive-failure threshold the ladder enters at. */
  actionsFailingHalt: number;
  yieldRefill?(): boolean;
  rotationReason?(): SourceVisitEndReason | null;
  /** Whether the journal step is wired (a settlement per due intent). */
  settlesJournal?: boolean;
  refillAvailableAt?(): number;
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
      gather: () => ({ atHardCeiling: rate.atHardCeiling(), actionsInLastHour: rate.actionsInLastHour() }),
    },

    pacing: pacingSource(d),

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
        // Finding new people waits while the list surface is unconfirmed (spec §10.6); queued follows continue.
        const exploring = !d.pacing.paused('exploration');
        return {
          queuedForTarget: target === null ? 0 : queuedCountFor(store, target.pk),
          lowWaterCandidates: exploring ? Math.min(d.settings().lowWaterCandidates, EXPLORATION_POLICY.queuedPerSource) : 0,
          targetExhausted: d.targets.isExhausted(),
          yieldToAction: d.yieldRefill?.() ?? false,
          rotationReason: d.rotationReason?.() ?? null,
          refillAvailableAt: d.refillAvailableAt?.() ?? 0,
        };
      },
    },

    cadence: {
      staleAfterMs: 0,
      gather: async (read) => {
        const { now } = await read('clock');
        return {
          sweepDue: sweepDue(d, now),
          journalDue: journalDue(d, now),
          // SEAM (wave B): `chronos.due(now)` fills this before the first tick.
          overdue: [],
        };
      },
    },

    action: actionSource(d),

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
