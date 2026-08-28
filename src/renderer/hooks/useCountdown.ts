import { useRef } from 'preact/hooks';
import type { EpoStatus } from '@/types';

export interface Countdown {
  /** True while the engine is running and a real deadline is pending. */
  active: boolean;
  /** Seconds until the next action. */
  remainingSec: number;
  /** Remaining fraction of the interval (1 = just acted, 0 = due). */
  frac: number;
}

const IDLE: Countdown = { active: false, remainingSec: 0, frac: 0 };

/**
 * Time-to-next-action from the engine's REAL pending deadline (`nextActionAt`,
 * the DelayManager's registered action-delay deadline) — no more estimating from
 * the settings band midpoint, so the countdown is exact for growth and would be
 * exact for prune's ×1/3 pace alike. The caller supplies `now` (its `useNow`
 * tick) so one clock drives every readout in the card — no second interval.
 */
export function useCountdown(status: EpoStatus | null, now: number): Countdown {
  /** First sighting of a RESTORED deadline (no lastActionAt) — anchors the
   *  ring's denominator so it depletes across ticks instead of re-deriving
   *  from the same `now` as the numerator (which pinned it at "full" until
   *  the final second, then snapped to empty). */
  const restored = useRef<{ deadline: number; seenAt: number } | null>(null);

  const running = status?.state === 'running';
  if (!running || !status || status.nextActionAt == null) {
    return IDLE;
  }
  // `lastActionAt` is in-memory only, so after an app relaunch the engine can
  // be genuinely serving a RESTORED (durable) delay with no last action on
  // record — the countdown must still show, anchored at the deadline's first
  // sighting so the fill genuinely depletes.
  let intervalMs: number;
  if (status.lastActionAt != null) {
    intervalMs = status.nextActionAt - status.lastActionAt;
  } else {
    if (restored.current?.deadline !== status.nextActionAt) {
      restored.current = { deadline: status.nextActionAt, seenAt: now };
    }
    intervalMs = Math.max(1, status.nextActionAt - restored.current.seenAt);
  }
  if (intervalMs <= 0) return IDLE;
  const remaining = Math.max(0, status.nextActionAt - now);
  return {
    active: true,
    remainingSec: Math.round(remaining / 1000),
    frac: Math.min(1, Math.max(0, remaining / intervalMs)),
  };
}

/**
 * Countdown to an arbitrary hold deadline — a long engine park (outside active
 * hours, today's plan done, between sessions, …) whose status carries only the
 * deadline. Uses the same first-sighting anchor as the restored branch above:
 * the ring's denominator is fixed when the hold is first seen, so the fill
 * genuinely depletes across ticks instead of re-deriving from `now`.
 */
export function useHoldCountdown(until: number | null, now: number): Countdown {
  const anchor = useRef<{ deadline: number; seenAt: number } | null>(null);
  if (until == null) {
    anchor.current = null;
    return IDLE;
  }
  if (anchor.current?.deadline !== until) {
    anchor.current = { deadline: until, seenAt: now };
  }
  const intervalMs = Math.max(1, until - anchor.current.seenAt);
  const remaining = Math.max(0, until - now);
  return {
    active: true,
    remainingSec: Math.round(remaining / 1000),
    frac: Math.min(1, Math.max(0, remaining / intervalMs)),
  };
}
