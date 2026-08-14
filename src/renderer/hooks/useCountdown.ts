import { useEffect, useState } from 'preact/hooks';
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

  const running = status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || !status || status.nextActionAt == null || status.lastActionAt == null) {
    return IDLE;
  }
  const intervalMs = status.nextActionAt - status.lastActionAt;
  if (intervalMs <= 0) return IDLE;
  const remaining = Math.max(0, status.nextActionAt - now);
  return {
    active: true,
    remainingSec: Math.round(remaining / 1000),
    frac: Math.min(1, Math.max(0, remaining / intervalMs)),
  };
}
