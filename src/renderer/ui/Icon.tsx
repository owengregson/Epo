/** @jsx h */
import { h } from 'preact';

export interface IconProps {
  /** FontAwesome glyph name WITHOUT the `fa-` prefix, e.g. "play", "gauge-high". */
  name: string;
  /** Use the brands set (`fa-brands`) instead of solid (`fa-solid`). */
  brand?: boolean;
  /** Apply the spin animation (loading spinners). */
  spin?: boolean;
  /** Extra classes appended after the FontAwesome classes. */
  class?: string;
  /**
   * Accessible label. When omitted the glyph is decorative (`aria-hidden`);
   * when provided the icon is exposed as an image with this label.
   */
  title?: string;
}

/**
 * Thin, faithful wrapper over self-hosted FontAwesome 7. Renders a real
 * `<i class="fa-solid fa-…">` element — the same class-based API the mockup used —
 * with the webfonts bundled as data: URIs (no CDN, works offline under CSP).
 * Decorative by default; pass `title` to give it an accessible name.
 */
export function Icon({ name, brand, spin, class: cls, title }: IconProps): h.JSX.Element {
  const family = brand ? 'fa-brands' : 'fa-solid';
  const classes = [family, `fa-${name}`, spin ? 'fa-spin' : null, cls || null]
    .filter(Boolean)
    .join(' ');
  return (
    <i
      class={classes}
      aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined}
      aria-label={title}
      title={title}
    />
  );
}
