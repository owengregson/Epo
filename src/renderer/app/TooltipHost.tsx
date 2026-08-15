/** @jsx h */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

interface TipState {
  text: string;
  rect: DOMRect;
}

/** Delay before a tooltip appears on hover. */
const SHOW_DELAY_MS = 250;

/**
 * The single global tooltip popover. Listens for hover over any `[data-tip]`
 * element and shows one fixed-position bubble (portal-style, so the scrolling
 * settings pane never clips it). Positioned above the anchor, flipping below near
 * the top edge and clamping to the viewport.
 */
export function TooltipHost(): h.JSX.Element {
  const [tip, setTip] = useState<TipState | null>(null);
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

  // Position the popover once it (and its measured size) exists.
  useEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const left = Math.max(8, Math.min(tip.rect.left, window.innerWidth - tw - 8));
    let top = tip.rect.top - th - 8;
    if (top < 8) top = tip.rect.bottom + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [tip]);

  // An initial position from the anchor rect, applied in the SAME render that adds
  // `.show` — so the reveal animates from near its final spot instead of visibly
  // snapping from (0,0). The effect above then refines it with the measured size.
  const style = tip
    ? {
        left: `${Math.max(8, Math.min(tip.rect.left, window.innerWidth - 258))}px`,
        top: `${tip.rect.top > 56 ? tip.rect.top - 44 : tip.rect.bottom + 8}px`,
      }
    : undefined;

  return (
    <div
      class={tip ? 'tip show' : 'tip'}
      ref={ref}
      style={style}
      role="tooltip"
      aria-hidden={tip ? 'false' : 'true'}
    >
      {tip?.text}
    </div>
  );
}
