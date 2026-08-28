/** @jsx h */
import { h } from 'preact';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange(value: T): void;
  ariaLabel?: string;
  /** Renders the group inert (dimmed, unclickable) while still showing the stored value. */
  disabled?: boolean;
}

/**
 * A segmented radiogroup (`.seg`) with roving-tabindex keyboard support: arrow
 * keys move selection and focus. Controlled via `value`. When `disabled`, the
 * buttons are truly inert (native `disabled`) and the group reads dimmed — the
 * stored value stays visible so the user can see what WOULD apply.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
}: SegmentedProps<T>): h.JSX.Element {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  const onKeyDown = (e: KeyboardEvent): void => {
    if (disabled) return;
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const nx = (idx + dir + options.length) % options.length;
    onChange(options[nx].value);
    const group = e.currentTarget as HTMLElement;
    const btn = group.querySelectorAll('button')[nx] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div
      class={disabled ? 'seg disabled' : 'seg'}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on ? 'true' : 'false'}
            tabIndex={on && !disabled ? 0 : -1}
            disabled={disabled}
            class={on ? 'active' : undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
