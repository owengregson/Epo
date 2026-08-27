/** @jsx h */
/**
 * The interactive intro tour — a coach-marks overlay across the whole window.
 * One spotlight ring cuts a hole in the dim over the current step's target
 * (found by its `data-tour` attribute) and one raised tip card narrates; steps
 * with no target render the card centered (welcome / finish). Each step drives
 * the REAL shell — switching the sidebar view and the stage — so the element
 * being described is actually on screen, live.
 *
 * Interaction: Next/Back buttons, backdrop click = Next, ←/→ arrows, Esc =
 * dismiss. Every way out lands in `onClose`, which persists completion — the
 * tour never nags twice.
 */
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { StageMode } from '@/types';
import type { ViewKey } from '../hooks/useView';
import { Icon } from '../ui/Icon';
import { TOUR_STEPS } from './steps';

export interface TourProps {
  open: boolean;
  /** Close the tour (the shell persists completion and restores the stage). */
  onClose(): void;
  goTo(view: ViewKey): void;
  setStage(stage: StageMode): void;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Spotlight breathing room around the target. */
const PAD = 6;
/** Gap between the ring and the tip card. */
const GAP = 14;
/** Minimum gutter between the card and the viewport edge. */
const EDGE = 12;

const sameBox = (a: Box | null, b: Box | null): boolean => {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
};

export function Tour({ open, onClose, goTo, setStage }: TourProps): h.JSX.Element | null {
  const [idx, setIdx] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const step = TOUR_STEPS[idx];
  const last = idx === TOUR_STEPS.length - 1;
  const advance = (): void => {
    if (last) onClose();
    else setIdx((i) => Math.min(i + 1, TOUR_STEPS.length - 1));
  };

  // Restart from the first step each time the tour opens.
  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  // Step entry drives the shell: the described element must be on screen.
  useEffect(() => {
    if (!open || step === undefined) return;
    if (step.view !== undefined) goTo(step.view);
    if (step.stage !== undefined) setStage(step.stage);
  }, [open, step, goTo, setStage]);

  // Track the target's rect every frame while open: view/stage swaps animate
  // for ~350ms and panes can resize mid-step, so a one-shot measure would pin
  // the ring to a stale spot. One getBoundingClientRect per frame on a single
  // element is negligible; state only updates when the rect actually moves.
  useEffect(() => {
    if (!open) return;
    const target = step?.target;
    if (target === undefined) {
      setBox(null);
      return;
    }
    let raf = 0;
    const track = (): void => {
      const el = document.querySelector(`[data-tour="${target}"]`);
      const r = el?.getBoundingClientRect();
      const next =
        r !== undefined && r.width > 0 && r.height > 0
          ? { x: r.x, y: r.y, w: r.width, h: r.height }
          : null;
      setBox((prev) => (sameBox(prev, next) ? prev : next));
      raf = requestAnimationFrame(track);
    };
    raf = requestAnimationFrame(track);
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  // Place the tip card beside the ring (measured, then clamped into the
  // viewport). Centered steps position themselves in CSS — inline left/top
  // are cleared so a stale spotlight position can't override the centering.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card === null || !open) return;
    if (box === null) {
      card.style.left = '';
      card.style.top = '';
      return;
    }
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const side = step?.side ?? 'below';
    let left: number;
    let top: number;
    if (side === 'inside') {
      left = box.x + box.w / 2 - cw / 2;
      top = box.y + box.h / 2 - ch / 2;
    } else if (side === 'right') {
      left = box.x + box.w + GAP;
      top = box.y + box.h / 2 - ch / 2;
    } else if (side === 'left') {
      left = box.x - cw - GAP;
      top = box.y + box.h / 2 - ch / 2;
    } else if (side === 'above') {
      left = box.x + box.w / 2 - cw / 2;
      top = box.y - ch - GAP;
    } else {
      left = box.x + box.w / 2 - cw / 2;
      top = box.y + box.h + GAP;
    }
    card.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - cw - EDGE))}px`;
    card.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - ch - EDGE))}px`;
  }, [open, box, step]);

  // Keyboard: Esc dismisses, arrows step. Enter is left to the focused button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (last) onClose();
        else setIdx((i) => Math.min(i + 1, TOUR_STEPS.length - 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, last, onClose]);

  // Focus the primary button per step so Enter always means "keep going".
  useEffect(() => {
    if (open) nextRef.current?.focus();
  }, [open, idx]);

  if (!open || step === undefined) return null;

  // Three card modes: positioned beside a measured target, hidden for the
  // frame(s) before the target's first measure lands (no centered flash), or
  // centered for the targetless welcome/finish steps.
  const wantsSpot = step.target !== undefined;
  const spot = wantsSpot && box !== null;
  const cardClass = spot ? 'tour-card' : wantsSpot ? 'tour-card measuring' : 'tour-card centered';
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard parity is global — ←/→/Esc are bound at the document level while the tour is open
    <div
      class="tour"
      role="dialog"
      aria-modal="true"
      aria-label="Intro tour"
      onClick={(e) => {
        // Backdrop click advances; clicks inside the card are the card's own.
        const t = e.target as HTMLElement;
        if (t === e.currentTarget || t.classList.contains('tour-veil')) advance();
      }}
    >
      {spot && box !== null ? (
        <div
          class="tour-ring"
          style={`left:${box.x - PAD}px; top:${box.y - PAD}px; width:${box.w + PAD * 2}px; height:${box.h + PAD * 2}px`}
        />
      ) : (
        <div class="tour-veil" />
      )}
      <div class={cardClass} ref={cardRef} key={idx}>
        <button class="tour-x" type="button" aria-label="Skip the tour" onClick={onClose}>
          <Icon name="xmark" />
        </button>
        <div class="tour-kicker">
          Intro tour · {idx + 1} / {TOUR_STEPS.length}
        </div>
        <div class="tour-t">{step.title}</div>
        <div class="tour-b">{step.body}</div>
        <div class="tour-a">
          <div class="tour-dots" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} class={i === idx ? 'dot on' : 'dot'} />
            ))}
          </div>
          {idx > 0 ? (
            <button class="tbtn" type="button" onClick={() => setIdx((i) => Math.max(0, i - 1))}>
              Back
            </button>
          ) : (
            <button class="tbtn" type="button" onClick={onClose}>
              Skip
            </button>
          )}
          <button class="tbtn tour-next" type="button" ref={nextRef} onClick={advance}>
            {last ? 'Finish' : idx === 0 ? 'Take the tour' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
