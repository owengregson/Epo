/**
 * The tempo overrides' parameter keys (spec §6.5, Appendix B.4): `tempo.<key>` for every tempo key
 * except `gap.action` and `check.spacing`, which other parameters set. Import-free; a test pins the
 * tuple to the kernel's tempo registry, in registry order.
 */

export const TEMPO_PARAM_KEYS = [
  'tempo.gap.accept', 'tempo.dwell.visit', 'tempo.dwell.before-press', 'tempo.ui.step-pause',
  'tempo.drawer.close-settle', 'tempo.scroll.wait.drawer', 'tempo.scroll.wait.dialog', 'tempo.scroll.wait.acquire',
  'tempo.scroll.depth.drawer', 'tempo.scroll.depth.dialog', 'tempo.walk.page', 'tempo.walk.rest',
  'tempo.walk.rest-every', 'tempo.pause.retry', 'tempo.pause.wake-settle',
  'tempo.park.blocked', 'tempo.backoff.walled', 'tempo.beat.transient',
  'tempo.motion.travel', 'tempo.motion.press', 'tempo.motion.pre-press', 'tempo.motion.hover-settle',
  'tempo.wheel.tick-pause', 'tempo.wheel.micro-pause', 'tempo.wheel.correction-pause',
] as const;
