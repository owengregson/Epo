/**
 * The growth loop's wait vocabulary: every key it may wait under, that key's
 * noise class, and whether the wait is a LONG park the status must surface.
 * Kept beside the engine (not in `timing/`) because the keys are the engine's,
 * but separate from it so the tables are readable and unit-testable on their own.
 */

import type { WaitResult } from '../timing/delay-manager';
import type { WaitClass } from '../timing/noise';
import type { DelayPolicy } from '../timing/primitives';

/**
 * Every DelayManager key the Engine waits under — the closed set the noise
 * registry classifies. A new wait site REQUIRES a key here and in
 * {@link ENGINE_WAIT_CLASS}, or tsc fails.
 */
export type EngineWaitKey =
  | 'engine:active-hours-park'
  | 'engine:daily-ceiling-park'
  | 'engine:session-park'
  | 'engine:velocity-park'
  | 'engine:enrich-backoff'
  | 'engine:read-budget-park'
  | 'engine:prune-park'
  | 'engine:blocked-park'
  | 'engine:idle'
  | 'engine:transient-backoff'
  | 'engine:action-delay'
  | 'engine:refill-pacing'
  | 'engine:recovery-hold';

/**
 * The per-key noise classification the wait gate applies. 'exact' keys already
 * draw their own jitter at the call site — noising them again double-jitters.
 * The `satisfies` makes an unclassified new key a tsc error.
 */
export const ENGINE_WAIT_CLASS = {
  'engine:active-hours-park': 'daily-boundary',
  'engine:daily-ceiling-park': 'daily-boundary',
  'engine:enrich-backoff': 'retry-backoff',
  // The allowance reopens at a KNOWN time: never wake before it, never stretch it 2×.
  'engine:read-budget-park': 'daily-boundary',
  'engine:prune-park': 'retry-backoff',
  'engine:blocked-park': 'retry-backoff',
  'engine:idle': 'local-beat',
  'engine:transient-backoff': 'local-beat',
  'engine:action-delay': 'exact',
  'engine:refill-pacing': 'exact',
  'engine:session-park': 'exact',
  'engine:velocity-park': 'exact',
  'engine:recovery-hold': 'exact',
} as const satisfies Record<EngineWaitKey, WaitClass>;

/**
 * Why a LONG park is holding the loop — the closed set of reasons a running
 * engine deliberately waits minutes-to-hours between steps. Surfaced as
 * `EngineStatus.parkReason` so a parked engine is distinguishable from an idle
 * one for the whole hold.
 */
export type EngineParkReason =
  | 'active-hours'
  | 'daily-ceiling'
  | 'session'
  | 'velocity'
  | 'enrich-backoff'
  /** @deprecated-renderer No wait parks under it any more; the old live-status card still names it. */
  | 'reconcile-backoff'
  /** The rolling profile-read allowance is spent; it reopens at a known time. */
  | 'read-budget'
  | 'recovery';

/**
 * Keys whose waits are LONG parks the status must surface. Short operational
 * waits (idle beat, refill pacing, transient backoff, the brief prune-park
 * retry) stay unlisted — they are step-scale, not hold-scale; the paced action
 * delay surfaces separately through `nextActionAt`.
 */
const PARK_REASON_BY_KEY = new Map<EngineWaitKey, EngineParkReason>([
  ['engine:active-hours-park', 'active-hours'],
  ['engine:daily-ceiling-park', 'daily-ceiling'],
  ['engine:session-park', 'session'],
  ['engine:velocity-park', 'velocity'],
  ['engine:enrich-backoff', 'enrich-backoff'],
  ['engine:read-budget-park', 'read-budget'],
  ['engine:recovery-hold', 'recovery'],
]);

/** The park reason `key` surfaces, or null when the wait is step-scale. */
export function parkReasonFor(key: string): EngineParkReason | null {
  return PARK_REASON_BY_KEY.get(key as EngineWaitKey) ?? null;
}

/**
 * The wait gate every engine component parks through — the Engine's own
 * `engineWait`, handed to collaborators (the refill pipeline) so no component
 * owns a timer of its own.
 */
export type EngineWait = (
  key: EngineWaitKey,
  policyOrMs: DelayPolicy | number,
) => Promise<WaitResult>;
