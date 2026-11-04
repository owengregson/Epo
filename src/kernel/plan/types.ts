/**
 * The day plan's vocabulary (ADR 0607, spec §5.15, Appendix A) — types only. The plan core writes
 * the functions over these; other layers read them through `governors/plan-types.ts` or the plan port.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import type { TempoKey } from '../tempo/keys';

/** What a read is for: the read allowance's `use` tag (the plan's read buckets). */
export type ReadUse = 'verify' | 'reconcile' | 'explore' | 'check' | 'census' | 'catch-up';

/** The rhythm/caution reference shape of the action gap at time-scale 1. */
export interface GapShape {
  readonly medianMs: number;
  readonly sigma: number;
  readonly floorMs: number;
  readonly capMs: number;
  readonly hawkesAlpha: number;
  readonly hawkesTauMs: number;
}

/** A session's gap: the reference shape time-scaled by τ toward its target mean. */
export interface GapSpec extends GapShape {
  readonly timeScale: number;
  readonly targetMeanMs: number;
}

/** One session's tempo: the factors every tempo spec resolves against (C25: two orthogonal flags). */
export interface SessionTempo {
  readonly z: number;
  readonly pace: number;
  readonly motion: number;
  readonly depth: number;
  readonly gap: GapSpec;
  readonly mix: 'normal' | 'boost';
  readonly probation: boolean;
}

/** The local date a plan-day window STARTS on, 'YYYY-MM-DD'. */
export type PlanDayKey = string;

/** One plan-day: [startsAt, endsAt) between two quiet minutes (23, 24 or 25 h; DST-safe). */
export interface PlanDayWindow {
  readonly key: PlanDayKey;
  readonly startsAt: number;
  readonly endsAt: number;
  /** Minute of the local day the boundary sits on (0..1439). */
  readonly quietMinute: number;
}

/** The ONE plan-day boundary every day counter reads (spec §4.4); one swap site when the plan lands. */
export interface PlanDayClock {
  window(t: number): PlanDayWindow;
  dayKey(t: number): PlanDayKey;
  /** Called once per boundary with the window that just began; returns the unsubscribe. */
  onRoll(fn: (w: PlanDayWindow) => void): () => void;
}

export type MutationKind = 'follow' | 'unfollow' | 'accept';
export type Writer = 'growth' | 'woven' | 'cleanup-run' | 'manual' | 'accept-pass';
export type ReplanCause = 'day-start' | 'first-open' | 'settings' | 'demand' | 'boost-start' | 'boost-end' | 'clock' | 'repair';
export type PlanBinding = 'none' | 'band' | 'session-time' | 'light-day' | 'follow-bound' | 'day-off';
/** Sun..Sat, `Date.getDay()` order. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CircadianShape {
  readonly bumps: readonly { readonly centerHour: number; readonly amplitude: number; readonly widthHours: number }[];
  readonly overnightFloor: number;
  /** Sun..Sat. */
  readonly weekdayWeights: readonly number[];
  readonly weekendShiftHours: number;
}

/** The plan's inputs from Settings intent (spec §5.3). */
export interface PlanIntent {
  readonly operatingRate: number;
  readonly hardCeiling: number;
  readonly hourlyCap: number;
  readonly probationHourlyCap: number;
  readonly unfollowHourlyCap: number;
  readonly sessions: { readonly min: number; readonly max: number };
  readonly gap: GapShape;
  readonly gapTargetOverrideMs: number | null;
  readonly gapFloorOverrideMs: number | null;
  readonly volumeSigma: number;
  readonly restDayProbability: number;
  readonly consistencyScale: number;
  readonly cleanupShare: number;
  readonly cleanupPerDayCap: number | null;
  readonly patienceWaitMs: number;
  readonly checkSpacingOverrideMs: number | null;
  readonly acceptRequests: boolean;
  readonly shape: CircadianShape;
  readonly quietHours: { readonly startMinute: number; readonly endMinute: number } | null;
  readonly daysOff: readonly DayOfWeek[];
  /** Reference factors in [1, 3] (overrides only lengthen). */
  readonly tempoOverrides: Readonly<Partial<Record<TempoKey, number>>>;
  readonly planBuffer: number;
}

/** A store snapshot the plan wiring builds; audit only inside the plan. */
export interface PlanDemand {
  readonly lifecycleDueByDayEnd: number;
  readonly lifecycleBacklog: number;
  readonly pruneStock: number;
  readonly protectedReeval: number;
  readonly journalPending: number;
  readonly followsDoneToday: number;
  readonly outsideToday: number;
  readonly pendingRequests: number;
  /** Accepts per plan-day over the trailing seven. */
  readonly acceptsRecent: number;
  readonly ownHeader: { readonly followers: number | null; readonly following: number | null };
  readonly census: { readonly lastCompleteAt: number | null; readonly rowsPerPage: number | null };
}

export interface KindBudgets {
  readonly follow: number;
  readonly unfollow: number;
  readonly accept: number;
}

export interface SessionReads {
  readonly reconcile: number;
  readonly explore: number;
  readonly explorePages: number;
  readonly checks: number;
  readonly checkPages: number;
}

export interface ReadPlan extends SessionReads {
  readonly census: number;
  readonly following: number;
  readonly catchUp: { readonly profiles: number; readonly notifications: number; readonly pages: number };
}

export interface PlannedSession {
  readonly idx: number;
  readonly startAt: number;
  readonly expectedEndAt: number;
  readonly budget: number;
  readonly mix: KindBudgets;
  readonly reads: SessionReads;
  readonly tempo: SessionTempo;
  readonly before: 'none' | 'first-open';
}

export interface BoostWindow {
  readonly v: 1;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly durationMs: number;
  readonly endedAt: number | null;
  readonly endReason: 'user' | 'expired' | 'clock' | null;
}

export interface DayPlan {
  readonly v: 1;
  readonly window: PlanDayWindow;
  readonly revision: number;
  readonly cause: ReplanCause;
  readonly drawnAt: number;
  readonly firstOpenAt: number;
  readonly intentDigest: string;
  readonly seed: number;
  readonly volume: { readonly lognormal: number; readonly band: number; readonly rest: boolean;
    readonly drawn: number; readonly planned: number; readonly binding: PlanBinding;
    /** Unspent allocations removed by re-plans; never refunded by a later lift (absent in older plans). */
    readonly forfeited?: number };
  readonly ceilings: { readonly automaticMax: number; readonly day: number; readonly hour: number;
    readonly unfollowHour: number; readonly probationHour: number; readonly followDay: number; readonly acceptsPerPass: number };
  readonly kinds: KindBudgets & { readonly lifecycleUnfollow: number; readonly slack: number };
  readonly reads: ReadPlan;
  readonly dayTempo: { readonly z: number };
  readonly sessions: readonly PlannedSession[];
  /** Audit only. */
  readonly demand: PlanDemand;
}

export interface DrawInput {
  readonly installEntropy: number;
  readonly window: PlanDayWindow;
  readonly intent: PlanIntent;
  readonly demand: PlanDemand;
  readonly phaseOffsetHours: number;
  readonly firstOpenAt: number;
  readonly boost: BoostWindow | null;
  /** Boost's act-now insertion keys on this (spec §8.2). */
  readonly runIntent: 'running' | 'stopped' | 'paused';
}

export interface PlanPreviewDay {
  readonly dayKey: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly restDay: boolean;
  readonly dayOff: boolean;
  readonly total: number;
  readonly follows: number;
  readonly unfollows: number;
  readonly accepts: number;
  readonly sessions: readonly { readonly startAt: number; readonly endAt: number; readonly budget: number }[];
}
