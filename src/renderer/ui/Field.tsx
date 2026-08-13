/** @jsx h */
import { h, type ComponentChildren } from 'preact';
import { Icon } from './Icon';

export type HintKind = 'default' | 'warn' | 'alarm';

export interface FieldProps {
  /** Label content (may include a `<span class="dim2">` qualifier). */
  label: ComponentChildren;
  /** Tooltip text; renders the hover "?" marker + popover via the global tooltip. */
  tip?: string;
  /** Associates the label with a control (native input `id`). */
  htmlFor?: string;
  /** Right-aligned formatted readout (`.fv`). */
  value?: ComponentChildren;
  /** Preset-locked appearance (grays + freezes the control). */
  locked?: boolean;
  /** Small "preset"/lock chip text shown when locked. */
  lockLabel?: string;
  /** Marks this field lockable so a preset can toggle it (`data-lockable`). */
  lockable?: boolean;
  /** Optional hint line under the control. */
  hint?: ComponentChildren;
  hintKind?: HintKind;
  /** Hide the hint (e.g. a conditional alarm). */
  hintHidden?: boolean;
  /** The control(s). */
  children: ComponentChildren;
}

/**
 * A settings row: a top line (label + optional lock chip + formatted readout),
 * the control, and an optional hint. The single place field chrome is defined,
 * so every setting reads identically.
 */
export function Field({
  label,
  tip,
  htmlFor,
  value,
  locked,
  lockLabel = 'preset',
  lockable,
  hint,
  hintKind = 'default',
  hintHidden,
  children,
}: FieldProps): h.JSX.Element {
  const fieldClass = ['field', locked ? 'locked' : null].filter(Boolean).join(' ');
  const hintClass = ['hint', hintKind !== 'default' ? hintKind : null].filter(Boolean).join(' ');
  return (
    <div class={fieldClass} data-lockable={lockable ? '' : undefined}>
      <div class="ftop">
        <label for={htmlFor} data-tip={tip}>
          {label}
        </label>
        {locked ? (
          <span class="lockmark" title="Locked by preset — choose Custom to edit">
            <Icon name="lock" />
            {lockLabel}
          </span>
        ) : null}
        {value != null ? <output class="fv num">{value}</output> : null}
      </div>
      {children}
      {hint != null ? (
        <div class={hintClass} hidden={hintHidden}>
          {hintKind === 'alarm' ? <Icon name="triangle-exclamation" /> : null}
          {hintKind === 'warn' ? <Icon name="circle-exclamation" /> : null}
          {hint}
        </div>
      ) : null}
    </div>
  );
}
