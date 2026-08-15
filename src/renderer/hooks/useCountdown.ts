import { useEffect, useRef, useState } from 'preact/hooks';
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
 * exact for prune's ×1/3 pace alike. Ticks once a second while running.
 */
export function useCountdown(status: EpoStatus | null): Countdown {
  const [now, setNow] = useState(() => Date.now());
  /** First sighting of a RESTORED deadline (no lastActionAt) — anchors the
   *  ring's denominator so it depletes across ticks instead of re-deriving
   *  from the same `now` as the numerator (which pinned it at "full" until
   *  the final second, then snapped to empty). */
  const restored = useRef<{ deadline: number; seenAt: number } | null>(null);

  const running = status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

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
