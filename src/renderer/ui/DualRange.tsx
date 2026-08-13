/** @jsx h */
import { h } from 'preact';
import { useRef } from 'preact/hooks';

export interface DualRangeProps {
  min: number;
  max: number;
  step: number;
  /** Minimum separation between the handles (defaults to `step`). */
  gap?: number;
  lo: number;
  hi: number;
  onChange(lo: number, hi: number): void;
  /** Optional inner "peak" band, clamped to [lo, hi]. */
  peak?: { lo: number; hi: number } | null;
  /** Formats the evenly-spaced scale labels (omit to hide the scale). */
  scaleFmt?(v: number): string;
  scaleStops?: number;
  /** Formats aria-value* on the handles. */
  ariaFmt?(v: number): string;
  ariaLabelLo?: string;
  ariaLabelHi?: string;
  disabled?: boolean;
}

/**
 * A dual-handle range with an optional inner peak band (`.dual`). Pointer drag
 * and arrow-key nudges (Shift = ×2). Fully controlled: the parent owns lo/hi and
 * receives every change through `onChange`.
 */
export function DualRange({
  min,
  max,
  step,
  gap = step,
  lo,
  hi,
  onChange,
  peak,
  scaleFmt,
  scaleStops = 6,
  ariaFmt = (v) => String(v),
  ariaLabelLo = 'Minimum',
  ariaLabelHi = 'Maximum',
  disabled,
}: DualRangeProps): h.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (v: number): number => ((v - min) / (max - min)) * 100;
  const snap = (v: number): number => Math.round(v / step) * step;

  const fromX = (clientX: number): number => {
    const t = trackRef.current;
    if (!t) return lo;
    const r = t.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return snap(min + f * (max - min));
  };

  const move = (v: number, isLo: boolean): void => {
    if (disabled) return;
    if (isLo) {
      const nl = Math.max(min, Math.min(v, hi - gap));
      onChange(Number(nl.toFixed(4)), hi);
    } else {
      const nh = Math.min(max, Math.max(v, lo + gap));
      onChange(lo, Number(nh.toFixed(4)));
    }
  };

  const onPointerDown = (e: PointerEvent, isLo: boolean): void => {
    if (disabled) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => move(fromX(ev.clientX), isLo);
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (e: KeyboardEvent, isLo: boolean): void => {
    if (disabled) return;
    let d = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step;
    else return;
    e.preventDefault();
    if (e.shiftKey) d *= 2;
    move((isLo ? lo : hi) + d, isLo);
  };

  let peakLeft = 0;
  let peakWidth = 0;
  let peakShown = false;
  if (peak) {
    const pl = Math.max(lo, peak.lo);
    const ph = Math.min(hi, peak.hi);
    if (ph > pl) {
      peakShown = true;
      peakLeft = pct(pl);
      peakWidth = pct(ph) - pct(pl);
    }
  }

  const stops: string[] = [];
  if (scaleFmt) {
    for (let i = 0; i < scaleStops; i++) {
      stops.push(scaleFmt(min + (max - min) * (i / (scaleStops - 1))));
    }
  }

  return (
    <div class="dual">
      <div class="dual-track" ref={trackRef}>
        <div class="dual-band" style={`left:${pct(lo)}%;width:${pct(hi) - pct(lo)}%`} />
        {peak ? (
          <div
            class="dual-peak"
            style={peakShown ? `left:${peakLeft}%;width:${peakWidth}%` : 'display:none'}
          />
        ) : null}
        <div
          class="dual-h"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabelLo}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={lo}
          aria-valuetext={ariaFmt(lo)}
          style={`left:${pct(lo)}%`}
          onPointerDown={(e) => onPointerDown(e, true)}
          onKeyDown={(e) => onKeyDown(e, true)}
        />
        <div
          class="dual-h"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabelHi}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={hi}
          aria-valuetext={ariaFmt(hi)}
          style={`left:${pct(hi)}%`}
          onPointerDown={(e) => onPointerDown(e, false)}
          onKeyDown={(e) => onKeyDown(e, false)}
        />
      </div>
      {scaleFmt ? (
        <div class="dual-scale num">
          {stops.map((s, i) => (
            <span key={i}>{s}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
