import { useEffect, useState } from 'preact/hooks';
import type { EpoStatus, Settings } from '@/types';

export interface Countdown {
  /** True while the engine is running and an ETA can be derived. */
  active: boolean;
  /** Seconds until the (estimated) next action. */
  remainingSec: number;
  /** Remaining fraction of the interval (1 = just acted, 0 = due). */
  frac: number;
}

const IDLE: Countdown = { active: false, remainingSec: 0, frac: 0 };

/**
 * Estimates time-to-next-action from `lastActionAt` + the delay band midpoint
 * (spec §3: derive an ETA, else show waiting). Ticks once a second while running;
 * the exact schedule is jittered internally, so this is a smooth approximation.
 */
export function useCountdown(status: EpoStatus | null, settings: Settings | null): Countdown {
  const [now, setNow] = useState(() => Date.now());

  const running = status?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || !settings || !status || status.lastActionAt == null) return IDLE;

  const intervalMs = ((settings.minDelayMinutes + settings.maxDelayMinutes) / 2) * 60_000;
  if (intervalMs <= 0) return IDLE;
  const remaining = Math.max(0, intervalMs - (now - status.lastActionAt));
  return {
    active: true,
    remainingSec: Math.round(remaining / 1000),
    frac: remaining / intervalMs,
  };
}
