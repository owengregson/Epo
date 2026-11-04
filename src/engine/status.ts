import type { SentinelStatus } from '../adapter/sentinel';
import type { EngineParkReason } from './engine-waits';
import type { EngineState, StepResult } from './ports';
import type { RuntimeHealthSnapshot } from './runtime-health';
import type { SourceFrontierSnapshot } from './source-frontier';

/** Status projection over the store + governors + Engine state. */
export interface EngineStatus {
  health?: RuntimeHealthSnapshot;
  frontier?: SourceFrontierSnapshot;
  /** @deprecated Never populated; the old renderer still reads it; `status.catchUp`/`journal` replace it (removal sweep). */
  reentry?: Readonly<Record<string, unknown>> & {
    readonly phase: 'reconcile' | 'probation' | 'ready'; readonly absentMs: number; readonly probationActions: number };
  state: EngineState;
  currentTargetPk: string | null;
  currentTargetUsername: string | null;
  chainIndex: number | null;
  actionsToday: number;
  remainingToday: number;
  /** Today's automatic volume: the plan-day's V (spec §5.4). */
  plannedToday: number;
  atHardCeiling: boolean;
  queued: number;
  pendingFollowback: number;
  followedBackHeld: number;
  unfollowDue: number;
  lastStep: StepResult | null;
  lastSentinel: SentinelStatus | null;
  lastActionAt: number | null;
  sessionStartedAt: number | null;
  /** Deadline (epoch ms) of the in-flight paced action delay, else null. */
  nextActionAt: number | null;
  /**
   * Deadline (epoch ms) of the in-flight LONG park (outside active hours,
   * today's plan done, between sessions, velocity hold, enrich backoff).
   * Registered — and pushed — the moment the park starts, BEFORE it is
   * awaited, and null once the wait resolves. Optional only because the
   * pre-build status literal predates it; the Engine always sets it.
   */
  parkedUntil?: number | null;
  /** Why the engine is parked while `parkedUntil` is set; null otherwise. */
  parkReason?: EngineParkReason | null;
  netToday: number;
  /** Whether the connectivity monitor last reported the internet reachable. */
  online: boolean;
  /** Why the engine halted (`sentinel:*`, `chain-exhausted`, `recovery-exhausted`,
   *  …) while `state` is `'halted'`; null otherwise. */
  haltReason: string | null;
  /**
   * The recovery ladder's live posture: `holding` while a long backoff is
   * armed (`resumeAt` is its absolute deadline), `probing` while the next real
   * actions decide whether the wall lifted. Null when the ladder is inactive.
   */
  recovery: {
    phase: 'holding' | 'probing';
    attempt: number;
    maxAttempts: number;
    resumeAt: number | null;
  } | null;
  /** @deprecated Organic-pacing session status (null in legacy mode); `status.plan` replaces it (removal sweep). */
  pacing?: {
    sessionOpen: boolean;
    sessionEndsAt: number | null;
    nextSessionAt: number | null;
    sessionsToday: number;
    dailyTarget: number;
  } | null;
}

