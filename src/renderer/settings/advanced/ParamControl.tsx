/**
 * One Advanced value's control by kind (spec §6.5): a stepper with a typed input in the row's unit (Enter
 * or leaving the field commits, Esc reverts), two inputs for a range, a switch for a flag. Steppers stay
 * inside the safe range; a typed value goes to main as asked, and main reports any clamp.
 */
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { ParamUnit } from '@/shared/settings-params';
import type { ParamView } from '@/shared/settings-view';
import { ROW_COPY } from '../copy/advanced';

/** How a unit shows in an input: shares as percents, the rest as they are. */
export function displayScale(unit: ParamUnit): { readonly scale: number; readonly suffix: string } {
  switch (unit) {
    case 'share': return { scale: 100, suffix: '%' };
    case 'percent': return { scale: 1, suffix: '%' };
    case 'seconds': return { scale: 1, suffix: 's' };
    case 'ms': return { scale: 1, suffix: 'ms' };
    case 'hours': return { scale: 1, suffix: 'h' };
    case 'days': return { scale: 1, suffix: 'days' };
    case 'per-day': return { scale: 1, suffix: 'a day' };
    case 'per-hour': return { scale: 1, suffix: 'an hour' };
    case 'factor': return { scale: 1, suffix: '×' };
    default: return { scale: 1, suffix: '' };
  }
}

/** Decimal places that a step needs ("0.05" → 2). */
const placesOf = (step: number): number => {
  const t = String(step);
  return t.includes('.') ? t.length - t.indexOf('.') - 1 : 0;
};

export function shown(v: number, p: Pick<ParamView, 'unit' | 'step'>): string {
  const { scale } = displayScale(p.unit);
  const places = Math.max(0, placesOf(p.step) - Math.round(Math.log10(scale)));
  return String(Number((v * scale).toFixed(places)));
}

export interface NumberControlProps {
  p: ParamView;
  value: number;
  label: string;
  describedBy?: string;
  min: number;
  max: number;
  onCommit(v: number): void;
}

/** −, the value as a typed input with its unit, +. */
export function NumberControl({ p, value, label, describedBy, min, max, onCommit }: NumberControlProps): JSX.Element {
  const { scale, suffix } = displayScale(p.unit);
  const [text, setText] = useState<string | null>(null);
  const revert = useRef(false);
  const step = (dir: 1 | -1): void => {
    const next = Number((value + dir * p.step).toFixed(placesOf(p.step)));
    onCommit(Math.min(max, Math.max(min, next)));
  };
  const commit = (raw: string): void => {
    setText(null);
    const n = Number.parseFloat(raw.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (Number.isFinite(n) && n / scale !== value) onCommit(n / scale);
  };
  return (
    <span class="set-stepper">
      <button type="button" aria-label={`${ROW_COPY.less}: ${label}`} disabled={value <= min} onClick={() => step(-1)}>
        −
      </button>
      <span class="set-stepper__value num">
        <input
          type="text"
          inputMode="decimal"
          aria-label={label}
          aria-describedby={describedBy}
          value={text ?? shown(value, p)}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onBlur={(e) => {
            if (revert.current) {
              revert.current = false;
              setText(null);
            } else commit((e.currentTarget as HTMLInputElement).value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              revert.current = true;
              setText(null);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
        {suffix ? <small>{suffix}</small> : null}
      </span>
      <button type="button" aria-label={`${ROW_COPY.more}: ${label}`} disabled={value >= max} onClick={() => step(1)}>
        +
      </button>
    </span>
  );
}

/** A range as two steppers: From and To. */
export function RangeControl({ p, value, label, onCommit }: {
  p: ParamView; value: { min: number; max: number }; label: string; onCommit(v: { min: number; max: number }): void;
}): JSX.Element {
  const b = p.bounds.kind === 'bool' ? { min: 0, max: 0 } : p.bounds;
  return (
    <span class="set-range">
      <span class="set-range__end">
        <small>{ROW_COPY.min}</small>
        <NumberControl p={p} value={value.min} label={`${label}: ${ROW_COPY.min}`} min={b.min} max={value.max} onCommit={(v) => onCommit({ ...value, min: v })} />
      </span>
      <span class="set-range__end">
        <small>{ROW_COPY.max}</small>
        <NumberControl p={p} value={value.max} label={`${label}: ${ROW_COPY.max}`} min={value.min} max={b.max} onCommit={(v) => onCommit({ ...value, max: v })} />
      </span>
    </span>
  );
}
