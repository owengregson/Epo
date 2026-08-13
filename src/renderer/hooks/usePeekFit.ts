import { useEffect } from 'preact/hooks';

/**
 * Pixels of the third card left visible at the fold — the deliberate "peek"
 * that signals the Overview scrolls. Normalized from the mockup's peek-fit
 * (`PEEK = 76` in docs/mockups/command-console.html).
 */
export const PEEK_PX = 76;

/** Minimum leftover space (px) worth distributing — below this we leave layout alone. */
const MIN_EXTRA_PX = 8;

/**
 * Overview peek-fit: grows the view's top two `.card` children just enough that
 * the third card is cut at the fold with a fixed {@link PEEK_PX} peek (a scroll
 * affordance). Only ever grows (`min-height`) — never clips content. Re-fits on
 * load, resize, font settle, and any size change of the view itself; a hidden
 * view (`clientHeight === 0`) is left untouched until it becomes measurable.
 */
export function usePeekFit(viewId: string, refitKey?: unknown): void {
  useEffect(() => {
    const view = document.getElementById(viewId);
    if (!view) return;

    const fit = (): void => {
      if (view.clientHeight === 0) return; // hidden view — nothing to measure
      const cards = Array.from(view.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('card'),
      );
      if (cards.length < 3) return;
      const grow = [cards[0], cards[1]];
      const third = cards[2];
      grow.forEach((c) => {
        c.style.minHeight = ''; // measure natural height first
      });
      const extra = view.clientHeight - PEEK_PX - third.offsetTop;
      if (extra > MIN_EXTRA_PX) {
        // only grow — never clip
        const each = extra / grow.length;
        grow.forEach((c) => {
          c.style.minHeight = `${c.offsetHeight + each}px`;
        });
      }
    };

    fit();
    window.addEventListener('load', fit);
    window.addEventListener('resize', fit);
    if (document.fonts?.ready) {
      void document.fonts.ready.then(() => fit());
    }
    // The view's box also changes with the fluid frame / view switches,
    // not only on viewport resize — observe it directly.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => fit());
      ro.observe(view);
    }
    return () => {
      window.removeEventListener('load', fit);
      window.removeEventListener('resize', fit);
      if (ro) ro.disconnect();
    };
  }, [viewId, refitKey]);
}
