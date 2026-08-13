/** @jsx h */
import { h } from 'preact';

export interface ToggleProps {
  checked: boolean;
  onChange(next: boolean): void;
  ariaLabel?: string;
}

/** A pill switch (`.toggle`). Space/Enter toggle; controlled via `checked`. */
export function Toggle({ checked, onChange, ariaLabel }: ToggleProps): h.JSX.Element {
  const toggle = (): void => onChange(!checked);
  return (
    <div
      class={checked ? 'toggle on' : 'toggle'}
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={ariaLabel}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle();
        }
      }}
    />
  );
}
