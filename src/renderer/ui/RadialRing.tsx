/** @jsx h */
import { h } from 'preact';
import { Icon } from './Icon';
import { clamp } from '../lib/format';

const R = 25;
const CIRC = 2 * Math.PI * R;

export interface RadialRingProps {
  /** Remaining fraction 0..1 (1 = full ring, 0 = depleted). */
  frac: number;
  /** Optional centered FontAwesome glyph. */
  glyph?: string;
}

/**
 * The depleting countdown ring (`.hn-ring`). The fill arc shrinks as `frac`
 * falls; the −90° rotation (12-o'clock start) comes from CSS.
 */
export function RadialRing({ frac, glyph }: RadialRingProps): h.JSX.Element {
  const offset = CIRC * (1 - clamp(frac, 0, 1));
  return (
    <div class="hn-ring" aria-hidden="true">
      <svg width="58" height="58" viewBox="0 0 58 58">
        <circle class="nr-track" cx="29" cy="29" r={R} />
        <circle
          class="nr-fill"
          cx="29"
          cy="29"
          r={R}
          style={`stroke-dasharray:${CIRC.toFixed(2)};stroke-dashoffset:${offset.toFixed(2)}`}
        />
      </svg>
      {glyph ? (
        <span class="glyph">
          <Icon name={glyph} />
        </span>
      ) : null}
    </div>
  );
}
