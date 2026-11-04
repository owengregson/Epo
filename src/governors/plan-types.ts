/**
 * The plan service's ports and its pure view (spec §5.15, Appendix A) — types
 * only. The plan core implements them; the engine reads the view through its
 * plan port, the settings stage previews through `PlanPreviewPort`.
 */

import type {
  BoostWindow,
  DayPlan,
  KindBudgets,
  MutationKind,
  PlanDayWindow,
  PlanDemand,
  PlanIntent,
  PlanPreviewDay,
  ReplanCause,
  SessionReads,
  SessionTempo,
  Writer,
} from '../kernel/plan';

export interface UsageTally {
  readonly all: number;
  readonly auto: number;
  readonly manual: number;
  readonly follow: number;
  readonly unfollow: number;
  readonly accept: number;
  readonly perSession: readonly number[];
  /** Ledger kind totals inside each session window; older callers may omit them and fail closed. */
  readonly perSessionKinds?: readonly KindBudgets[];
  readonly outside: number;
}

export type AdmitRefusal = 'session-closed' | 'kind-spent' | 'day-done' | 'ceiling' | 'hourly-cap'
  | 'deadline' | 'deferred-by-boost' | 'journal' | 'probation' | 'quiet-hours' | 'day-off' | 'unconfirmed';

/** May this action run now? A refusal says why and, when known, until when. */
export type Admission = { readonly ok: true } | { readonly ok: false; readonly reason: AdmitRefusal; readonly until: number | null };

export type SessionState = 'done' | 'partial' | 'skipped' | 'before-open' | 'now' | 'next' | 'later';

/** The plan at an instant: pure, read-only, derived from the persisted plan and the ledgers. */
export interface PlanView {
  readonly plan: DayPlan;
  readonly provisional: boolean;
  readonly at: number;
  readonly window: PlanDayWindow;
  readonly sessions: readonly { readonly idx: number; readonly state: SessionState; readonly used: number;
    readonly budget: number; readonly closesAt: number | null }[];
  readonly open: { readonly idx: number; readonly mixLeft: KindBudgets; readonly readsLeft: SessionReads;
    readonly mix: 'normal' | 'boost'; readonly probation: boolean; readonly censusHost: boolean } | null;
  /** Null ⇒ parks end at window.endsAt. */
  readonly nextSessionAt: number | null;
  readonly nextCheckAt: number | null;
  readonly used: UsageTally;
  readonly remaining: number;
  readonly R: number;
  readonly boost: BoostWindow | null;
  /** = plan.window.startsAt (display only). */
  readonly freshSince: number;
  /** The open session's tempo, else the ambient one. */
  readonly tempo: SessionTempo;
  admits(kind: MutationKind, writer: Writer, subject?: { pk: string; intentId?: string }): Admission;
  manualOpen(): Admission;
  checkDue(lastSweepEndedAt: number | null): boolean;
  checkLight(): boolean;
  censusDue(census: { readonly lastCompleteAt: number | null; readonly walkPages: number }): boolean;
  acceptsAllowed(pending: number, lastHour: number): number;
  mixDraw(k: number): number | null;
  planDayStartAfter(k: number): number;
}

/** The persisted plan state's store slice (raw strings; the plan core validates). */
export interface PlanStore {
  getPlanState(): string | null;
  setPlanState(raw: string | null): void;
  /** Read once for the phase migration (the legacy key, then cleared). */
  getPacingState(): string | null;
  tallySince(since: number): Omit<UsageTally, 'perSession' | 'outside'>;
  recentMutationTimes(since: number): readonly number[];
  /** Upgrade probation for any install with a ledger. */
  hasAnyMutation(): boolean;
}

export interface PlanServiceDeps {
  store: PlanStore;
  clock: { now(): number };
  installEntropy: number;
  launchSeed: number;
  intent(): PlanIntent;
  demand(window: PlanDayWindow, now: number): PlanDemand;
  lastMutationBefore(t: number): number | null;
  /** Increases only (spec §9.10). */
  outsideSince(since: number): number;
  deadline(): number | null;
  journal: { blocks(pk: string, exceptIntentId?: string): boolean };
  runIntent(): 'running' | 'stopped' | 'paused';
  unconfirmed(): { readonly kind: 'follow' | 'unfollow'; readonly streak: number } | null;
  surfaceGate: { paused(a: 'unfollows' | 'exploration'): boolean };
  onChanged?(view: PlanView, cause: ReplanCause): void;
}

/** The settings stage's what-if: plan-days drawn for an intent, without writing anything. */
export interface PlanPreviewPort {
  previewDays(intent: PlanIntent, at: number, days: number): readonly PlanPreviewDay[];
}
