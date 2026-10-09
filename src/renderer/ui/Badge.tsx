import { type ComponentChildren, type JSX } from 'preact';

export type BadgeTone = 'default' | 'live' | 'warn';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ComponentChildren;
}

/** A small uppercase pill label (source badges, hop markers, states). */
export function Badge({ tone = 'default', children }: BadgeProps): JSX.Element {
  const classes = ['badge', tone !== 'default' ? tone : null].filter(Boolean).join(' ');
  return <span class={classes}>{children}</span>;
}
