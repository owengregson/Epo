/** @jsx h */
import { h, Fragment, type ComponentChildren } from 'preact';
import { Icon } from './Icon';

export interface CardProps {
  /** Elevated variant (brighter surface + stronger shadow). */
  raised?: boolean;
  /** Entrance-stagger index; sets the `--i` custom property the stagger reads. */
  index?: number;
  class?: string;
  children: ComponentChildren;
}

/** A console card surface. Compose with {@link CardHeader} / {@link CardBody}. */
export function Card({ raised, index, class: cls, children }: CardProps): h.JSX.Element {
  const classes = ['card', raised ? 'raised' : null, cls || null].filter(Boolean).join(' ');
  return (
    <div class={classes} style={index != null ? `--i:${index}` : undefined}>
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  /** Leading FontAwesome glyph name (without `fa-`). */
  icon?: string;
  brand?: boolean;
  /** Right-aligned auxiliary text (rendered muted, tabular). */
  aux?: ComponentChildren;
  children: ComponentChildren;
}

/** A card's eyebrow header: icon + label, with optional right-aligned aux text. */
export function CardHeader({ icon, brand, aux, children }: CardHeaderProps): h.JSX.Element {
  return (
    <div class="card-h">
      {icon ? <Icon name={icon} brand={brand} /> : null}
      {children}
      {aux != null ? (
        <Fragment>
          <span class="spacer" />
          <span class="aux num">{aux}</span>
        </Fragment>
      ) : null}
    </div>
  );
}

export interface CardBodyProps {
  class?: string;
  children: ComponentChildren;
}

/** A card's padded body region. */
export function CardBody({ class: cls, children }: CardBodyProps): h.JSX.Element {
  return <div class={cls ? `card-b ${cls}` : 'card-b'}>{children}</div>;
}
