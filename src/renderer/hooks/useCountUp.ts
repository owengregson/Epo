/**
 * useCountUp — smooth numeric interpolation for live counters.
 *
 * Scan counts arrive in page-sized jumps (+50 at a time, throttled pushes);
 * rendering those jumps directly makes the ticker lurch. This hook chases the
 * target with a requestAnimationFrame animation, retargeting from wherever the
 * display currently sits — so overlapping pushes read as one unbroken count-up.
 *
 * Two chase modes:
 * - Default: fixed `durationMs` with an ease-out — a quick settle (headline
 *   numbers, completion rides).
 * - `paced`: a smoothstep ease-in-out whose duration tracks the source's own
 *   push cadence (an EMA of observed inter-push gaps, scaled to arrive just
 *   short of the next expected push). The display is in motion for the whole
 *   gap instead of sprinting and idling — the visual of continuous scanning —
 *   easing up out of each arrival and decelerating into the next; because the
 *   curve starts and ends at zero velocity, chained segments blend without
 *   kinks, and because each new push retargets from the current display, it
 *   can never fall behind.
 *
 * Downward moves SNAP (a scan reset to 0 must not "count down"), and under
 * `prefers-reduced-motion` the hook is a pass-through. Pass `round: false` for
 * continuous quantities (percentages) that must not quantize to integer steps.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { prefersReducedMotion } from '@/renderer/lib/motion';

export interface CountUpOptions {
  /** Fixed chase duration (ms); also the paced mode's pre-cadence fallback. */
  durationMs?: number;
  /** Round each frame to an integer (odometer counters). Default true. */
  round?: boolean;
  /** Match the chase to the source's push cadence (see module doc). */
  paced?: boolean;
}

/** Paced mode: fraction of the expected gap to fill (the rest is margin) —
 *  generous, since the ease-in-out's slow ends already read as settling. */
const PACE_FILL = 0.95;
/** Paced mode: EMA weight of the newest inter-push gap sample. */
const PACE_EMA_ALPHA = 0.4;
/** Paced mode: clamp on gap samples and chase durations (ms). */
const PACE_MIN_MS = 300;
const PACE_MAX_MS = 30_000;

export function useCountUp(target: number, opts?: CountUpOptions): number {
  const durationMs = opts?.durationMs ?? 900;
  const round = opts?.round ?? true;
  const paced = opts?.paced ?? false;

  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  const rafRef = useRef<number | null>(null);
  const prevTargetRef = useRef(target);
  const lastPushAtRef = useRef<number | null>(null);
  const gapEmaRef = useRef<number | null>(null);

  useEffect(() => {
    const from = displayRef.current;

    // Cadence tracking: every target CHANGE is a push, including resets — the
    // next segment's duration is sized to the smoothed gap between them.
    const changed = target !== prevTargetRef.current;
    prevTargetRef.current = target;
    if (paced && changed) {
      const now = performance.now();
      if (lastPushAtRef.current !== null) {
        const gap = Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, now - lastPushAtRef.current));
        gapEmaRef.current =
          gapEmaRef.current === null
            ? gap
            : gapEmaRef.current * (1 - PACE_EMA_ALPHA) + gap * PACE_EMA_ALPHA;
      }
      lastPushAtRef.current = now;
    }

    if (prefersReducedMotion() || target <= from) {
      displayRef.current = target;
      setDisplay(target);
      return undefined;
    }

    const chaseMs = paced
      ? Math.min(PACE_MAX_MS, Math.max(PACE_MIN_MS, (gapEmaRef.current ?? durationMs) * PACE_FILL))
      : durationMs;
    const start = performance.now();
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / chaseMs);
      // Paced segments ride a smoothstep ease-in-out sized to the push gap —
      // easing without losing pace (the full distance still lands within the
      // paced duration); fixed segments keep the quick ease-out settle.
      const eased = paced ? t * t * (3 - 2 * t) : 1 - (1 - t) ** 3;
      const raw = from + (target - from) * eased;
      const value = round ? Math.round(raw) : raw;
      displayRef.current = value;
      setDisplay(value);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs, round, paced]);

  return display;
}
