/** @jsx h */
import { h } from 'preact';
import { Icon } from './Icon';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id?: string;
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange(value: string): void;
  ariaLabel?: string;
}

/** A styled native `<select>` (`.selwrap`) with a chevron affordance. */
export function Select({ id, value, options, onChange, ariaLabel }: SelectProps): h.JSX.Element {
  return (
    <div class="selwrap">
      <select
        class="sel num"
        id={id}
        value={value}
        aria-label={ariaLabel}
        onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" />
    </div>
  );
}
