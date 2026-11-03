import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { boxOf, coveredRegion } from '@/renderer/app/overlay-bounds';
import { type PlaceOptions, place, placeAvoiding } from '@/renderer/lib/anchor';

export interface PopoverRequest {
  /** The element the popover belongs to; focus returns to it on close. */
  anchor: Element;
  content: () => JSX.Element;
  /** The id of the element inside `content` that names the popover. */
  labelledBy: string;
}

const popoverSignal = signal<PopoverRequest | null>(null);

const CONTROLS = {
  open(r: PopoverRequest): void {
    popoverSignal.value = r;
  },
  close(): void {
    popoverSignal.value = null;
  },
};

/** Open and close the shell's one popover (a "Why?" checklist, a row's detail). */
export function usePopover(): { open(r: PopoverRequest): void; close(): void } {
  return CONTROLS;
}

const OPTS: PlaceOptions = { side: 'below', align: 'start', gap: 8, edge: 8 };

/**
 * The shell-level popover layer (spec §12.4): one popover at a time, rendered
 * outside the console column so nothing clips it. Below its anchor, flipping
 * above near the bottom; on Live, kept inside the column its anchor sits in
 * (the Instagram page draws above everything here) and, when it cannot clear
 * the anchor there, laid over it inline. Escape or a press elsewhere closes it.
 */
export function PopoverHost(): JSX.Element | null {
  const req = popoverSignal.value;
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || req === null) return;
    const anchor = boxOf(req.anchor);
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const covered = coveredRegion();
    const column = covered !== null && anchor.x + anchor.w <= covered.x ? { w: covered.x, h: viewport.h } : viewport;
    const at = placeAvoiding(anchor, size, viewport, covered, OPTS) ?? place(anchor, size, column, OPTS);
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  }, [req]);

  useEffect(() => {
    if (req === null) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') CONTROLS.close();
    };
    const onPress = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && (ref.current?.contains(t) || req.anchor.contains(t))) return;
      CONTROLS.close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPress, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPress, true);
      if (req.anchor instanceof HTMLElement) req.anchor.focus();
    };
  }, [req]);

  if (req === null) return null;
  return (
    <div class="popover" role="dialog" aria-labelledby={req.labelledBy} tabIndex={-1} ref={ref}>
      {req.content()}
    </div>
  );
}
