import { type JSX } from 'preact';
import { BRAND_ICONS, ICONS } from '@/renderer/ui/icons';

export interface IconProps {
  /** Glyph name as it appears in `ui/icons.ts`, e.g. "play", "gauge-high". */
  name: string;
  /** Use the brand set instead of solid. */
  brand?: boolean;
  /** Apply the spin animation (loading spinners). */
  spin?: boolean;
  /** Extra classes appended after the icon classes. */
  class?: string;
  /**
   * Accessible label. When omitted the glyph is decorative (`aria-hidden`);
   * when provided the icon is exposed as an image with this label.
   */
  title?: string;
}

/**
 * Inline SVG glyph, sized in `em` so it follows the font-size of whatever hosts
 * it (that is what every `.icon` rule in the stylesheets tunes). Decorative by
 * default; pass `title` to give it an accessible name. An unknown name renders
 * an empty box rather than throwing — a missing glyph must not blank a card.
 */
export function Icon({ name, brand, spin, class: cls, title }: IconProps): JSX.Element {
  const glyph = (brand ? BRAND_ICONS : ICONS)[name];
  const classes = ['icon', spin ? 'icon-spin' : null, cls || null].filter(Boolean).join(' ');
  return (
    <svg
      class={classes}
      viewBox={glyph?.box ?? '0 0 512 512'}
      width="1em"
      height="1em"
      fill="currentColor"
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {glyph ? <path d={glyph.d} /> : null}
    </svg>
  );
}
