import { DUR, EASE, EASE_OUT, prefersReducedMotion, STAGGER_MS } from '@/renderer/lib/motion';

/** Per-card delay step (ms). */
const STEP_MS = 65;
/** Delay before the first card (ms). */
const BASE_MS = 60;
/** Entrance duration (ms). */
const DUR_MS = 450;
/** Delay cap — cards past this index share the last slot, so a long page's
 *  tail still lands promptly instead of trickling in for seconds. */
const CAP = 8;

const FRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(14px) scale(0.985)' },
  { opacity: 1, transform: 'translateY(0) scale(1)' },
];

/**
 * Play the card-entrance cascade inside `host` (a `.view` or `.stage-view`).
 *
 * The Web Animations API owns the whole contract — durations, the delay ramp,
 * and the reduced-motion gate — so there is no CSS/TS timing table to keep in
 * sync and no `index` prop to drill through every card. Re-running cancels the
 * previous pass, so rapid tab presses always animate the latest activation.
 * A no-op under reduced motion and wherever `Element.animate` is unavailable
 * (jsdom): the cards then simply render at their end state.
 */
export function staggerCards(host: HTMLElement | null): void {
  if (host === null || prefersReducedMotion()) return;
  const cards = host.querySelectorAll<HTMLElement>('.card');
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (typeof card.animate !== 'function') return;
    for (const running of card.getAnimations?.() ?? []) running.cancel();
    card.animate(FRAMES, {
      duration: DUR_MS,
      delay: Math.min(i, CAP) * STEP_MS + BASE_MS,
      easing: EASE,
      fill: 'both',
    });
  }
}

const SECTION_FRAMES: Keyframe[] = [
  { opacity: 0, transform: 'translateY(8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

/**
 * Play the arrival cascade over a stage page's top-level sections (spec §12.4:
 * every page runs it on open): each rises 8 px and fades in over `DUR[3]`,
 * `STAGGER_MS` apart. A no-op under reduced motion and where `Element.animate`
 * is missing (jsdom): the sections then simply render at their end state.
 */
export function staggerSections(host: HTMLElement | null): void {
  if (host === null || prefersReducedMotion()) return;
  const sections = host.children;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i] as HTMLElement;
    if (typeof section.animate !== 'function') return;
    for (const running of section.getAnimations?.() ?? []) running.cancel();
    section.animate(SECTION_FRAMES, {
      duration: DUR[3],
      delay: Math.min(i, CAP) * STAGGER_MS,
      easing: EASE_OUT,
      fill: 'both',
    });
  }
}
