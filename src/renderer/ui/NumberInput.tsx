/** @jsx h */
import { h } from 'preact';
import { commas } from '../lib/format';

export interface NumberInputProps {
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  ariaLabel?: string;
}

/**
 * A comma-formatted whole-number input (`.ninput`), e.g. follower bounds. Strips
 * non-digits, clamps, and re-formats with thousands separators on commit.
 */
export function NumberInput({
  value,
  onChange,
  min = 0,
  max = 1_000_000,
  ariaLabel,
}: NumberInputProps): h.JSX.Element {
  return (
    <input
      class="ninput num"
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={commas(value)}
      onChange={(e) => {
        let n = parseInt((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ''), 10);
        if (Number.isNaN(n)) n = min;
        onChange(Math.max(min, Math.min(max, n)));
      }}
    />
  );
}
