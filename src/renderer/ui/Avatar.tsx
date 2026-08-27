/** @jsx h */
import { type ComponentChildren, h } from 'preact';

export interface AvatarProps {
  /** Monogram letter (or glyph) shown inside. */
  children: ComponentChildren;
  /** Smaller variant (chain/queue rows). */
  small?: boolean;
  class?: string;
}

/** A monogram avatar disc (`.avatar`). */
export function Avatar({ children, small, class: cls }: AvatarProps): h.JSX.Element {
  const classes = ['avatar', small ? 'small' : null, cls || null].filter(Boolean).join(' ');
  return <div class={classes}>{children}</div>;
}
