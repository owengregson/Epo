/** @jsx h */
import { h } from 'preact';
import { Transport, type TransportProps } from './Transport';

/**
 * The one intentional inline SVG in the app: the Epo brand mark. Every other
 * icon is FontAwesome. Kept as a component so the mark is defined once.
 *
 * The mark is a "flattened 8 with a cutout" — a rounded-square with two rounded
 * counters and a crossbar (the 8), minus a slot opening the lower-right, which
 * reads as a lowercase `e` (Epo's initial). It is a single continuous silhouette
 * (one mask) so the brushed-metal gradient flows seamlessly, with the shine in
 * the edge: a bright top highlight over a satin body and a shadowed lower edge.
 */
function EpoMark(): h.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 64 64" fill="none" role="img" aria-label="Epo">
      <defs>
        <mask id="epo-mark-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect x="7" y="7" width="50" height="50" rx="16" ry="16" fill="#fff" />
          <rect x="15" y="15" width="34" height="13" rx="7" ry="7" fill="#000" />
          <rect x="15" y="36" width="34" height="13" rx="7" ry="7" fill="#000" />
          <rect x="43" y="36" width="21" height="10" fill="#000" />
        </mask>
        <linearGradient id="epo-mark-body" x1="0" y1="6" x2="0" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#eef1f5" />
          <stop offset="18%" stop-color="#c9cdd4" />
          <stop offset="44%" stop-color="#eceff3" />
          <stop offset="57%" stop-color="#abafb7" />
          <stop offset="80%" stop-color="#cccfd5" />
          <stop offset="100%" stop-color="#e7eaef" />
        </linearGradient>
        <linearGradient id="epo-mark-shadow" x1="0" y1="30" x2="0" y2="57" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#3a3d44" stop-opacity="0" />
          <stop offset="100%" stop-color="#2c2e34" stop-opacity="0.9" />
        </linearGradient>
        <linearGradient id="epo-mark-hi" x1="0" y1="7" x2="0" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95" />
          <stop offset="55%" stop-color="#ffffff" stop-opacity="0" />
        </linearGradient>
      </defs>
      <g mask="url(#epo-mark-cut)">
        <rect width="64" height="64" fill="url(#epo-mark-body)" />
        <rect width="64" height="64" fill="url(#epo-mark-shadow)" />
        <rect width="64" height="64" fill="url(#epo-mark-hi)" />
      </g>
    </svg>
  );
}

export type HeaderProps = TransportProps;

/**
 * The console header: the brand mark (whose hairline ring breathes while the
 * engine runs — driven by `.console[data-state]`), the static tagline, and the
 * transport trio beneath.
 */
export function Header(props: HeaderProps): h.JSX.Element {
  return (
    <div class="con-head">
      <div class="brand-row">
        <div class="logo-mark" aria-hidden="true">
          <EpoMark />
        </div>
        <div class="head-text">
          <h1>Epo</h1>
          <div class="tagline">Growth engine</div>
        </div>
      </div>
      <Transport {...props} />
    </div>
  );
}
