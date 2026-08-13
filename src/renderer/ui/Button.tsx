/** @jsx h */
import { h, type ComponentChildren } from 'preact';
import { Icon } from './Icon';

export interface ButtonProps {
  /** Destructive styling (`.danger` / red hover). */
  danger?: boolean;
  /** Full-width variant (`.wide`). */
  wide?: boolean;
  /** Leading FontAwesome glyph (without `fa-`). */
  icon?: string;
  /** Spin the leading glyph (pending state). */
  iconSpin?: boolean;
  id?: string;
  type?: 'button' | 'submit';
  title?: string;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  children?: ComponentChildren;
}

/**
 * The console's metal transport-style button (`.tbtn`). Used for the header trio
 * (via {@link Transport}) and standalone actions like Restart-from-seed.
 */
export function Button({
  danger,
  wide,
  icon,
  iconSpin,
  id,
  type = 'button',
  title,
  disabled,
  onClick,
  children,
}: ButtonProps): h.JSX.Element {
  const classes = ['tbtn', danger ? 'danger' : null, wide ? 'wide' : null].filter(Boolean).join(' ');
  return (
    <button id={id} type={type} class={classes} title={title} disabled={disabled} onClick={onClick}>
      {icon ? <Icon name={iconSpin ? 'spinner' : icon} spin={iconSpin} /> : null}
      {children}
    </button>
  );
}
