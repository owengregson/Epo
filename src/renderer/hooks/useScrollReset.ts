import { useEffect } from 'preact/hooks';
import type { ViewKey } from '@/renderer/hooks/useView';

/**
 * Scroll reset on view open. Every view stays mounted inside its own `.view`
 * section (`id="view-<key>"`, the actual scroll container — see layout.css), so
 * by default each would preserve its scroll position across tab switches. This
 * hook resets the INCOMING view's scrollTop to 0 whenever the active view
 * changes, so a view always opens at the top; the outgoing view keeps its
 * position while it fades (it is about to be hidden anyway).
 *
 * Kept as its own hook (not folded into `useView`) so the router itself stays
 * untouched — the reset is a one-line opt-in in the shell.
 */
export function useScrollReset(current: ViewKey): void {
  useEffect(() => {
    const el = document.getElementById(`view-${current}`);
    if (el) el.scrollTop = 0;
  }, [current]);
}
