/**
 * The registry's two change ledgers (ADR 0607, spec §5.12): the frozen snapshot of what the app shipped is
 * never edited, and every golden expects `snapshot − RETIRED ⊕ CHANGED`. A ledger, not a computation: the
 * live values derive in `derive.ts`. Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

/** A legacy registry key the day plan retired, what took its place, and why nothing reads it. */
export interface RetiredKey {
  readonly adr: '0607';
  readonly replacedBy: string;
  readonly reason: string;
}

/** A deliberate value change where the snapshot pins one: `groups.G.K`, `grid.knob=level.f`, `personas.id.f`, `profiles.key.f`. */
export interface ChangedValue {
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly adr: string;
}

const VELOCITY: RetiredKey = {
  adr: '0607',
  replacedBy: 'the exact trailing-hour window (MutationCadence.velocityParkUntil, spec §5.10)',
  reason: 'a full rolling hour parks until it has room again plus one gap draw; no log-normal park draw remains',
};
const ENTRY_SPACING: RetiredKey = {
  adr: '0607',
  replacedBy: 'the activity clock (IgActivityClock.spaceEntry, a dwell.visit draw at the session tempo)',
  reason: 'every Instagram operation is spaced at its entry, so the pacers callers stacked on top of it retire (spec §5.16)',
};
const SWEEP_FACTOR: RetiredKey = {
  adr: '0607',
  replacedBy: "the plan's check spacing (check.spacing, PlanView.checkDue)",
  reason: 'the persisted follow-back sweep factor retired with the watcher; the frozen v1 rules keep its range for the migration',
};
const SCHEDULED_PRUNE: RetiredKey = {
  adr: '0607',
  replacedBy: "cleanup woven into the plan's sessions, plus a manual Prune now (spec §14 C14)",
  reason: 'the scheduled bulk prune, its 30-minute watcher and its launch retired: nothing is scheduled or launched',
};

/** The retired keys (spec §5.12): 9 derived, 7 policy, 2 override and 2 unused harness values. */
export const RETIRED: Readonly<Record<string, RetiredKey>> = {
  'HARNESS.ENRICH_PACE_MIN_MS': ENTRY_SPACING,
  'HARNESS.ENRICH_PACE_MAX_MS': ENTRY_SPACING,
  'ENGINE.VELOCITY_PARK_MEDIAN_MS': VELOCITY,
  'ENGINE.VELOCITY_PARK_SIGMA': VELOCITY,
  'ENGINE.VELOCITY_PARK_MIN_MS': VELOCITY,
  'ENGINE.VELOCITY_PARK_MAX_MS': VELOCITY,
  'RIM.ENRICH_PACE_MIN_MS': { ...ENTRY_SPACING, reason: `${ENTRY_SPACING.reason}; a non-ok sentinel ends an enrichment pass` },
  'RIM.ENRICH_PACE_MAX_MS': { ...ENTRY_SPACING, reason: `${ENTRY_SPACING.reason}; a non-ok sentinel ends an enrichment pass` },
  'NOISE.PRUNE_LAUNCH_JITTER_MAX_MS': SCHEDULED_PRUNE,
  'NOISE.CADENCE_SIGMA': SWEEP_FACTOR,
  'NOISE.DAILY_BOUNDARY_JITTER_MAX_MS': {
    adr: '0607',
    replacedBy: 'exact plan-day parks (spec §5.16)',
    reason: 'its users, the daily-ceiling, read-budget and active-hours parks, are exact or deleted; the daily-boundary wait class went with them',
  },
  'PRUNE.DELAY_FACTOR': {
    adr: '0607',
    replacedBy: 'the shared deadline armed at dispatch (MutationCadence.armAtDispatch, the session GapSpec)',
    reason: "a cleanup run spaces its unfollows by the plan's gap, not by a third of the retired legacy pace",
  },
  'RIM.ACQUIRE_MAX_ROUNDS': {
    adr: '0607',
    replacedBy: 'EXPLORATION_POLICY.pagesPerSlice (the acquisition fallback sizes its rounds from the slice)',
    reason: 'dead: no acquisition read it once the slice shape bounded the dialog fallback',
  },
  'SCHEDULER.AUTO_PRUNE_CHECK_MS': SCHEDULED_PRUNE,
  'PRUNE.SCAN_FRESH_MS': {
    adr: '0607',
    replacedBy: "the plan's census rule (intent.patienceWaitMs and PlanView.censusDue, spec §5.8.3)",
    reason: "a census stays usable while the plan's durable census predicate says so; no fixed expiry of its own",
  },
  'NOISE.CADENCE_MIN_FACTOR': SWEEP_FACTOR,
  'NOISE.CADENCE_MAX_FACTOR': SWEEP_FACTOR,
  'SCHEDULER.USERNAME_REBUILD_BACKOFF_MS': {
    adr: '0607',
    replacedBy: "the boot sequence's confirm-account step (store-first identity, ADR 1010)",
    reason: 'the degraded-graph username retry left ensureBuilt, so nothing waits between rebuild attempts',
  },
  'ENGINE.REFILL_PACING_MIN_MS': { ...ENTRY_SPACING, reason: `${ENTRY_SPACING.reason}; a task ends without a beat of its own` },
  'ENGINE.REFILL_PACING_MAX_MS': { ...ENTRY_SPACING, reason: `${ENTRY_SPACING.reason}; a task ends without a beat of its own` },
};

/** Every deliberate value change the snapshot pins, in the order they landed. */
export const CHANGED: readonly ChangedValue[] = [
  // The prune cool-down rises from 2 h to the p50 soft wall it exists to sit out (ADR 0606).
  { path: 'groups.RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS', from: 7_200_000, to: 10_800_000, adr: '0606' },
];
