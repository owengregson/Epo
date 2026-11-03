import { type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { coveredRegion } from '@/renderer/app/overlay-bounds';
import { placeAvoiding } from '@/renderer/lib/anchor';

interface TipState {
  text: string;
  rect: DOMRect;
}

/** Delay before a tooltip appears on hover. */
const SHOW_DELAY_MS = 250;
/** Minimum gutter between the bubble and the viewport edge. */
const EDGE_PX = 8;
/** Gap between the bubble and its anchor. */
const GAP_PX = 8;

/**
 * The single global tooltip popover. Listens for hover over any `[data-tip]`
 * element and shows one fixed-position bubble at shell level (so no scrolling
 * pane or console column clips it). Positioned above the anchor, flipping below
 * near the top edge and clamping to the viewport. On Live the Instagram page
 * draws above everything here, so a bubble is kept inside the console column
 * its anchor sits in, and one that cannot avoid the page is not shown at all —
 * the anchor's own label carries the text (spec §12.4).
 */
export function TooltipHost(): JSX.Element {
  const [tip, setTip] = useState<TipState | null>(null);
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef<Element | null>(null);
  const timer = useRef<number | undefined>();

  useEffect(() => {
    const hide = (): void => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      current.current = null;
      setTip(null);
    };

    const onOver = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      const el = target?.closest?.('[data-tip]') ?? null;
      if (el === current.current) return;
      hide();
      if (el) {
        current.current = el;
        timer.current = window.setTimeout(() => {
          const text = el.getAttribute('data-tip') || '';
          if (text) setTip({ text, rect: el.getBoundingClientRect() });
        }, SHOW_DELAY_MS);
      }
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('scroll', hide, true);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  // Measure-then-show: the bubble mounts INVISIBLE (no `.show`, opacity 0),
  // this layout effect measures its real size and positions it before paint,
  // and only then `.show` is added — so the open animation always starts from
  // the final spot. A placement the native page would cover stays hidden.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) {
      setShown(false);
      return;
    }
    const at = placeAvoiding(
      { x: tip.rect.left, y: tip.rect.top, w: tip.rect.width, h: tip.rect.height },
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
      coveredRegion(),
      { side: 'above', align: 'start', gap: GAP_PX, edge: EDGE_PX },
    );
    if (at === null) {
      setShown(false);
      return;
    }
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
    setShown(true);
  }, [tip]);

  return (
    <div
      class={tip && shown ? 'tip show' : 'tip'}
      ref={ref}
      role="tooltip"
      aria-hidden={tip && shown ? 'false' : 'true'}
    >
      {tip?.text}
    </div>
  );
}
