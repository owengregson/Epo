/** @jsx h */
import { h } from 'preact';

export interface StepperProps {
  value: number;
  min: number;
  max: number;
  step: number;
  /** Fixed decimal places for display (e.g. 2 → "1.00"). Integer if omitted. */
  dec?: number;
  /** Suffix appended to the displayed value. */
  suffix?: string;
  onChange(value: number): void;
  ariaLabel?: string;
}

/** A −/value/+ numeric stepper (`.stepper`). Clamps + snaps to `step`. */
export function Stepper({ value, min, max, step, dec, suffix, onChange, ariaLabel }: StepperProps): h.JSX.Element {
  const fmt = (v: number): string => (dec ? v.toFixed(dec) : String(Math.round(v))) + (suffix || '');

  const commit = (raw: number): void => {
    let v = Number.isNaN(raw) ? value : raw;
    v = Math.round(v / step) * step;
    v = Math.max(min, Math.min(max, v));
    onChange(Number(v.toFixed(4)));
  };

  return (
    <div class="stepper">
      <button type="button" aria-label="Decrease" onClick={() => commit(value - step)}>
        −
      </button>
      <input
        class="num"
        type="text"
        inputMode="decimal"
        aria-label={ariaLabel}
        value={fmt(value)}
        onChange={(e) =>
          commit(parseFloat((e.currentTarget as HTMLInputElement).value.replace(/[^\d.-]/g, '')))
        }
      />
      <button type="button" aria-label="Increase" onClick={() => commit(value + step)}>
        +
      </button>
    </div>
  );
}
