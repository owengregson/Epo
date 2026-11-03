/**
 * The intro (spec §12.8): the splash mark flies into the masthead while the splash fades and the already
 * built app rises under it; the zones arrive a stagger apart and the ring and plan blocks draw in to their
 * current values (numbers never count up). Under reduced motion it is one short cross-fade. Every wait goes
 * through `play`, so where nothing animates (jsdom, reduced motion) the intro completes at once.
 */
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { DUR, STAGGER_MS } from '@/renderer/design/motion-scale';
import { EASE, EASE_OUT } from '@/renderer/lib/motion';
import { play } from '@/renderer/lib/play';

/** Moments of the intro, from its start: the splash hands over, Instagram may show, main hears the reveal. */
const INTRO = { HANDOFF_MS: DUR[4], LIVE_MS: DUR[4] + DUR[1], REVEALED_MS: DUR[5] } as const;

export interface IntroHooks {
  /** The splash is gone; the app is the page. */
  handoff(): void;
  /** Instagram may be uncovered on the Live stage. */
  live(): void;
  /** The intro is over: main may run the rest of its startup. */
  revealed(): void;
}

/** A beat between two moments of the intro; where nothing animates there is nothing to wait for. */
function wait(ms: number): Promise<void> {
  if (reducedMotionSignal.peek() || typeof Element.prototype.animate !== 'function') return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The mark's flight from the splash centre onto the masthead mark (a FLIP: the end rect is the masthead's). */
function flyMark(from: Element | null, to: Element | null): Promise<void> {
  if (from === null || to === null) return Promise.resolve();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (a.width === 0 || b.width === 0) return Promise.resolve();
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const end = `translate(${dx}px, ${dy}px) scale(${b.width / a.width})`;
  return play(from, [{ transform: 'none' }, { transform: end }], { duration: DUR[4], easing: EASE, fill: 'forwards' });
}

/** The column's zones and the stage bar rise in; the ring and the plan blocks draw to where they already are. */
function riseApp(root: ParentNode): void {
  const rise = [root.querySelector('.sb-mast'), root.querySelector('.stagebar')];
  for (const el of rise) {
    if (el !== null) void play(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: DUR[3], delay: DUR[1], easing: EASE_OUT, fill: 'backwards' });
  }
  root.querySelectorAll('.sidebar [data-zone="now"], .sidebar .sb-zone').forEach((zone, i) => {
    void play(zone, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
      { duration: DUR[3], delay: DUR[1] + i * STAGGER_MS, easing: EASE_OUT, fill: 'backwards' });
  });
  const arc = root.querySelector<SVGElement>('.sidebar .sb-ring__arc');
  if (arc !== null) {
    const at = getComputedStyle(arc).strokeDashoffset || '0';
    void play(arc, [{ strokeDashoffset: '1' }, { strokeDashoffset: at }], { duration: DUR[4], delay: DUR[1], easing: EASE_OUT });
  }
  root.querySelectorAll('.sidebar .sb-strip__block').forEach((block, i) => {
    void play(block, [{ transform: 'scaleX(0)' }, { transform: 'none' }],
      { duration: DUR[3], delay: DUR[2] + i * STAGGER_MS, easing: EASE_OUT, fill: 'backwards' });
  });
}

/**
 * Play the intro over `splash` (the `#boot` element), calling each hook at its moment. Reduced motion: the
 * splash cross-fades away and every hook runs right after.
 */
export async function playIntro(splash: HTMLElement, reduced: boolean, hooks: IntroHooks): Promise<void> {
  const root = splash.ownerDocument;
  if (reduced) {
    await play(splash, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR[2], fill: 'forwards' });
    hooks.handoff();
    hooks.live();
    hooks.revealed();
    return;
  }
  const mark = splash.querySelector('.boot-mark');
  const masthead = root.querySelector('.sidebar .sb-mast__mark');
  riseApp(root);
  const backdrop = splash.querySelector('.boot-backdrop') ?? splash;
  const fading = play(backdrop, [{ opacity: 1 }, { opacity: 0 }],
    { duration: DUR[4] - STAGGER_MS, delay: STAGGER_MS, easing: EASE, fill: 'forwards' });
  const under = splash.querySelector('.boot-under');
  if (under !== null) void play(under, [{ opacity: 1 }, { opacity: 0 }], { duration: DUR[1], fill: 'forwards' });
  await Promise.all([flyMark(mark, masthead), fading]);
  hooks.handoff();
  await wait(INTRO.LIVE_MS - INTRO.HANDOFF_MS);
  hooks.live();
  await wait(INTRO.REVEALED_MS - INTRO.LIVE_MS);
  hooks.revealed();
}
