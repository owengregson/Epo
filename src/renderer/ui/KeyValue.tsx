/** @jsx h */
import { type ComponentChildren, h } from 'preact';

export interface KeyValueProps {
  /** Left label. */
  k: ComponentChildren;
  /** Right value. */
  children: ComponentChildren;
  /** Render the value in the live/steel accent. */
  live?: boolean;
}

/** A single label→value row with a hairline divider (`.kv`). */
export function KeyValue({ k, children, live }: KeyValueProps): h.JSX.Element {
  return (
    <div class="kv">
      <span class="k">{k}</span>
      <span class={live ? 'v num live' : 'v num'}>{children}</span>
    </div>
  );
}
