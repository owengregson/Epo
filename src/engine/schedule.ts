/**
 * `Schedule` as DATA — the shape of a repeated wait, written down instead of
 * spelled out imperatively.
 *
 * Today the recovery ladder is a hand-rolled draw inside `RecoverySupervisor`
 * (`nextHoldMs`): a per-rung median, a log-normal jitter, a clamp band, a rung
 * count. All four are structure, not behaviour, so they can be a value —
 * `RECOVERY_LADDER` below reproduces exactly what the supervisor draws, and
 * `tests/engine/schedule.test.ts` proves it rung by rung.
 *
 * SEAM (wave B): `src/kernel/schedule.ts` is the permanent home; the runtime
 * wave may not import the kernel yet. When the supervisor becomes three Chronos
 * rows plus a classification rule, this datum is what it is built from.
 */

import { RECOVERY } from '../timing/config';
import { clamp, logNormal } from '../timing/distributions';
import type { Rng } from '../timing/primitives';
import { sample } from '../timing/primitives';
import { absurd } from './absurd';

/** A noise class, named the way `timing/noise.ts` names them. */
export type ScheduleNoise = 'retry-backoff' | 'exact';

export type Schedule =
  /** One attempt, `ms` after the trigger. */
  | { k: 'once'; ms: number }
  /** `ms` after each attempt, `n` times. */
  | { k: 'recurs'; ms: number; n: number }
  /** `base × factor^(attempt-1)`, never above `cap`. */
  | { k: 'exponential'; base: number; factor: number; cap: number }
  /** Each draw spread log-normally around the inner value, clamped to a band. */
  | { k: 'jittered'; inner: Schedule; sigma: number; min: number; max: number }
  /** At most `n` attempts; beyond that the schedule is spent. */
  | { k: 'truncate'; inner: Schedule; n: number }
  /** The exact per-attempt values, in order — a table, when no formula fits. */
  | { k: 'table'; ms: readonly number[] };

/** How many attempts a schedule admits (`Infinity` when unbounded). */
export function attempts(s: Schedule): number {
  switch (s.k) {
    case 'once':
      return 1;
    case 'recurs':
      return s.n;
    case 'exponential':
      return Number.POSITIVE_INFINITY;
    case 'jittered':
      return attempts(s.inner);
    case 'truncate':
      return Math.min(s.n, attempts(s.inner));
    case 'table':
      return s.ms.length;
    default:
      return absurd(s);
  }
}

/** The un-jittered value for a 1-based `attempt`, before any noise. */
export function baseMs(s: Schedule, attempt: number): number {
  switch (s.k) {
    case 'once':
      return s.ms;
    case 'recurs':
      return s.ms;
    case 'exponential':
      return Math.min(s.cap, s.base * s.factor ** Math.max(0, attempt - 1));
    case 'jittered':
      return baseMs(s.inner, attempt);
    case 'truncate':
      return baseMs(s.inner, attempt);
    case 'table':
      return s.ms[Math.min(Math.max(attempt, 1), s.ms.length) - 1];
    default:
      return absurd(s);
  }
}

/**
 * Draw the wait for a 1-based `attempt`, or null once the schedule is spent.
 * Consumes `rng` EXACTLY as the imperative draw it replaces does, so the
 * distribution — and any seeded test — is unchanged.
 */
export function draw(s: Schedule, attempt: number, rng: Rng): number | null {
  if (attempt < 1 || attempt > attempts(s)) return null;
  switch (s.k) {
    case 'jittered': {
      const median = baseMs(s.inner, attempt);
      return sample(
        clamp(logNormal(median, s.sigma), median * s.min, median * s.max),
        rng,
      );
    }
    case 'truncate':
      return draw(s.inner, attempt, rng);
    default:
      return baseMs(s, attempt);
  }
}

/**
 * The recovery ladder (`docs/adr/0201-recovery-ladder.md`) as one value: the
 * per-rung medians, the log-normal spread, the clamp band, and the rung count —
 * the exact four inputs `RecoverySupervisor.nextHoldMs` + `beginHold` use.
 */
export const RECOVERY_LADDER: Schedule = {
  k: 'truncate',
  n: RECOVERY.MAX_HOLDS,
  inner: {
    k: 'jittered',
    sigma: RECOVERY.HOLD_SIGMA,
    min: RECOVERY.HOLD_MIN_FACTOR,
    max: RECOVERY.HOLD_MAX_FACTOR,
    inner: { k: 'table', ms: RECOVERY.HOLD_MEDIANS_MS },
  },
};
