/** @jsx h */
import { h, type ComponentChildren } from 'preact';

export interface StatProps {
  /** Uppercase micro-label. */
  label: ComponentChildren;
  /** The value (may contain a `<small>` unit). */
  children: ComponentChildren;
  /** Optional sub-line beneath the value. */
  sub?: ComponentChildren;
  /** Smaller value tier (for text values like a handle). */
  small?: boolean;
}

/** A boxed inset statistic cell (`.stat`). */
export function Stat({ label, children, sub, small }: StatProps): h.JSX.Element {
  return (
    <div class="stat">
      <div class="k">{label}</div>
      <div class={small ? 'v sm num' : 'v num'}>{children}</div>
      {sub != null ? <div class="ss">{sub}</div> : null}
    </div>
  );
}
