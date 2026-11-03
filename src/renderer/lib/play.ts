import { reducedMotionSignal } from '@/renderer/app/motion-signal';

/** Both ends of an animation's promise land here: finishing and being replaced are alike to a caller. */
const settled = (): void => undefined;

/**
 * Every Web Animations call goes through here (spec §12.7): it resolves when the
 * animation ends or a newer one cancels it, and at once where nothing animates —
 * under reduced motion or without `Element.animate` (jsdom) — so no logic ever
 * waits on motion.
 */
export function play(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions): Promise<void> {
  if (reducedMotionSignal.peek() || typeof el.animate !== 'function') return Promise.resolve();
  return el.animate(frames, opts).finished.then(settled, settled);
}
