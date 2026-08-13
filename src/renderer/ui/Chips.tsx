/** @jsx h */
import { h } from 'preact';

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

export interface ChipsProps<T extends string> {
  options: ReadonlyArray<ChipOption<T>>;
  value: T;
  onChange(value: T): void;
  ariaLabel?: string;
}

/** A single-select pill group (`.chips`), e.g. the follow-back sweep cadence. */
export function Chips<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: ChipsProps<T>): h.JSX.Element {
  return (
    <div class="chips num" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            class={on ? 'chip active' : 'chip'}
            aria-pressed={on ? 'true' : 'false'}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
