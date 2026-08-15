/** @jsx h */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

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
 * element and shows one fixed-position bubble (portal-style, so the scrolling
 * settings pane never clips it). Positioned above the anchor, flipping below near
 * the top edge and clamping to the viewport.
 */
export function TooltipHost(): h.JSX.Element {
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
  // the final spot. One flip rule (above unless it would leave the top gutter),
  // no estimated sizes to drift from the CSS.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) {
      setShown(false);
      return;
    }
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const left = Math.max(EDGE_PX, Math.min(tip.rect.left, window.innerWidth - tw - EDGE_PX));
    let top = tip.rect.top - th - GAP_PX;
    if (top < EDGE_PX) top = tip.rect.bottom + GAP_PX;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    setShown(true);
  }, [tip]);

  return (
    <div
      class={tip && shown ? 'tip show' : 'tip'}
      ref={ref}
      role="tooltip"
      aria-hidden={tip ? 'false' : 'true'}
    >
      {tip?.text}
    </div>
  );
}
