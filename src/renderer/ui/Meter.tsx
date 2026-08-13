/** @jsx h */
import { h } from 'preact';
import { clamp } from '../lib/format';

export interface MeterProps {
  /** Fill percentage 0..100. */
  pct: number;
  /** Brass (warning) fill instead of chrome. */
  brass?: boolean;
  class?: string;
}

/** A thin progress meter (`.bar`) with an animated fill. */
export function Meter({ pct, brass, class: cls }: MeterProps): h.JSX.Element {
  const w = clamp(pct, 0, 100);
  const classes = ['bar', brass ? 'brass' : null, cls || null].filter(Boolean).join(' ');
  return (
    <div class={classes}>
      <i style={`width:${w}%`} />
    </div>
  );
}
