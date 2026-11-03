import type { JSX } from 'preact';

export interface TimeSelectProps {
  label: string;
  /** The chosen minute of the day. */
  value: number;
  /** The minutes offered, in order. */
  options: readonly number[];
  /** How a minute reads ("11:30 PM"). */
  format(minute: number): string;
  onChange(minute: number): void;
  /** A minute that may not be chosen here (the other end of the window). */
  disabledValue?: number;
}

/** A labelled native time picker: the platform's own select, so keyboard and screen readers just work. */
export function TimeSelect({ label, value, options, format, onChange, disabledValue }: TimeSelectProps): JSX.Element {
  return (
    <label class="time-select">
      <span>{label}</span>
      <select
        value={String(value)}
        onChange={(e) => onChange(Number((e.currentTarget as HTMLSelectElement).value))}
      >
        {options.map((m) => (
          <option key={m} value={String(m)} disabled={m === disabledValue}>
            {format(m)}
          </option>
        ))}
      </select>
    </label>
  );
}
