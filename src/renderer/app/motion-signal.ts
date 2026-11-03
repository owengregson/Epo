import { type ReadonlySignal, signal } from '@preact/signals';

/**
 * Whether the person asked the system for less motion, followed live: a change
 * in the OS setting reaches every reader without a reload (spec §12.7). False
 * where the media query does not exist (jsdom).
 */
const QUERY = '(prefers-reduced-motion: reduce)';

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;

const reduced = signal(media?.matches ?? false);
media?.addEventListener?.('change', (e) => {
  reduced.value = e.matches;
});

export const reducedMotionSignal: ReadonlySignal<boolean> = reduced;
