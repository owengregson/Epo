import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import type { Countdown } from '@/shared/posture';

/** The share of a countdown still ahead at `now`, in [0, 1] (the static fraction under reduced motion). */
export function remainingFraction(c: Countdown, now: number): number {
  const span = c.to - c.from;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (c.to - now) / span));
}

/**
 * The "deplete" gesture (spec §12.7): ONE linear animation from the share left at
 * `now` down to empty at `c.to`. The caller re-arms only when the deadline's
 * identity changes. `'dashoffset'` expects a stroke with `pathLength="1"` and a
 * dash of 1; `'scaleX'` a bar whose transform origin is its start. Returns null
 * where nothing animates (reduced motion, jsdom, a deadline already passed).
 */
export function armDeadline(
  el: SVGElement | HTMLElement,
  c: Countdown,
  now: number,
  prop: 'dashoffset' | 'scaleX',
): Animation | null {
  for (const running of el.getAnimations?.() ?? []) running.cancel();
  const left = remainingFraction(c, now);
  if (reducedMotionSignal.peek() || typeof el.animate !== 'function' || left <= 0) return null;
  const frames: Keyframe[] =
    prop === 'scaleX'
      ? [{ transform: `scaleX(${left})` }, { transform: 'scaleX(0)' }]
      : [{ strokeDashoffset: String(1 - left) }, { strokeDashoffset: '1' }];
  return el.animate(frames, { duration: c.to - now, easing: 'linear', fill: 'forwards' });
}
