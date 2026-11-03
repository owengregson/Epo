/**
 * Launch copy (spec Appendix C.15.7): the splash caption and the Live placeholder. Plain words; the splash
 * names what it waits for, and only after its caption delay.
 */
import type { BootView } from '@/shared/boot';

export const SPLASH = {
  data: 'Opening your data…',
  instagram: 'Opening Instagram…',
  almost: 'Almost there…',
  slow: 'Still loading — this can take a moment.',
} as const;

export const PLACEHOLDER = {
  loading: 'Opening Instagram…',
  offline: 'Instagram can’t load while you’re offline. Epo reloads it when you’re back online.',
  retry: 'Try again',
} as const;

/** What the splash caption says `elapsed` after launch (empty before the caption delay). */
export function splashCaption(
  boot: Pick<BootView, 'data' | 'ig'> | null,
  elapsed: number,
  delays: { readonly caption: number; readonly slow: number },
): string {
  if (elapsed < delays.caption) return '';
  if (elapsed >= delays.slow) return SPLASH.slow;
  if (boot === null || boot.data === 'pending') return SPLASH.data;
  return boot.ig === 'pending' ? SPLASH.instagram : SPLASH.almost;
}
