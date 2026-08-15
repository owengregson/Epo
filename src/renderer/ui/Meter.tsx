/** @jsx h */
import { h } from 'preact';
import { clamp } from '../lib/format';

export interface MeterProps {
  /** Fill percentage 0..100. */
  pct: number;
  /** Brass (warning) fill instead of chrome. */
  brass?: boolean;
  /**
   * The fill is driven by a stream of small updates (e.g. a rAF-interpolated
   * count), so the CSS width transition is disabled — updates arriving faster
   * than the transition's delay perpetually restart it and freeze the fill.
   */
  live?: boolean;
  class?: string;
}

/** A thin progress meter (`.bar`) with an animated fill. */
export function Meter({ pct, brass, live, class: cls }: MeterProps): h.JSX.Element {
  const w = clamp(pct, 0, 100);
  const classes = ['bar', brass ? 'brass' : null, live ? 'live' : null, cls || null]
    .filter(Boolean)
    .join(' ');
  return (
    <div class={classes}>
      <i style={`width:${w}%`} />
    </div>
  );
}
