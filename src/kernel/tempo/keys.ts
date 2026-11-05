/**
 * The closed set of tempo keys (ADR 0607, spec §5.11): every Instagram-facing
 * wait, dwell, scroll depth and gesture duration the plan's tempo scales. No key
 * paces a task's end: the activity clock spaces each entry with `dwell.visit`.
 */
export const TEMPO_KEYS = [
  'gap.action', 'gap.accept', 'dwell.visit', 'dwell.before-press', 'ui.step-pause', 'drawer.close-settle',
  'scroll.wait.drawer', 'scroll.wait.dialog', 'scroll.wait.acquire', 'scroll.depth.drawer', 'scroll.depth.dialog',
  'walk.page', 'walk.rest', 'walk.rest-every', 'pause.retry', 'pause.wake-settle',
  'park.blocked', 'backoff.walled', 'beat.transient', 'check.spacing',
  'motion.travel', 'motion.press', 'motion.pre-press', 'motion.hover-settle',
  'wheel.tick-pause', 'wheel.micro-pause', 'wheel.correction-pause',
] as const;

export type TempoKey = (typeof TEMPO_KEYS)[number];

/**
 * How a spec scales with the session: `pace` by the pace factor; `pace-up` by
 * max(1, pace), never shorter than its prior; `motion` by pace^½ per gesture;
 * `depth` by 1/pace (scroll distance and the rest stride).
 */
export type TempoAxis = 'pace' | 'pace-up' | 'motion' | 'depth';
