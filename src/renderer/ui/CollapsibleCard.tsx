/** @jsx h */
import { type ComponentChildren, h } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';

export interface CollapsibleCardProps {
  /** Leading FontAwesome glyph (without `fa-`). */
  icon?: string;
  title: string;
  /** Entrance-stagger index (`--i`). */
  index?: number;
  /** Start minimized (body hidden). */
  defaultCollapsed?: boolean;
  /** Right-aligned auxiliary readout, shown in the header even when collapsed. */
  aux?: ComponentChildren;
  raised?: boolean;
  children: ComponentChildren;
}

/**
 * A settings-card surface with a header-integrated minimize control (top-right): the
 * body collapses to just the header. Lets a long settings page stay scannable — most
 * sections start minimized and expand on demand. The body stays MOUNTED and slides
 * via the `.reveal` grid-rows pattern, so collapsing animates with the house easing
 * and child state (open disclosures, half-typed inputs) survives a minimize.
 */
export function CollapsibleCard({
  icon,
  title,
  index,
  defaultCollapsed = false,
  aux,
  raised,
  children,
}: CollapsibleCardProps): h.JSX.Element {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const classes = ['card', raised ? 'raised' : null, collapsed ? 'collapsed' : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div class={classes} style={index != null ? `--i:${index}` : undefined}>
      {/* The whole header row is the toggle; the chevron carries the hover tooltip. */}
      <button
        type="button"
        class="card-h card-h-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${title}` : `Minimize ${title}`}
        onClick={() => setCollapsed((c) => !c)}
      >
        {icon ? <Icon name={icon} /> : null}
        <span class="card-h-title">{title}</span>
        <span class="spacer" />
        {aux != null ? <span class="aux num">{aux}</span> : null}
        <span class="card-collapse" data-tip={collapsed ? 'Expand' : 'Minimize'} aria-hidden="true">
          <Icon name={collapsed ? 'chevron-down' : 'chevron-up'} />
        </span>
      </button>
      <div class={collapsed ? 'reveal' : 'reveal open'}>
        <div class="reveal-i">{children}</div>
      </div>
    </div>
  );
}
