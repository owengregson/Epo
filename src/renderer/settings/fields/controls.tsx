/**
 * Small controls every Settings section shares: a labelled switch row (`role="switch"`, help always
 * visible), the inline "not saved" line under a control whose change was refused, and a section sub-heading.
 */
import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { SAVE_COPY } from '../copy/sections';
import type { StageApi } from '../stage-api';

export interface SwitchRowProps {
  label: string;
  help?: string;
  checked: boolean;
  onChange(next: boolean): void;
  /** Extra content beside the label (a pill such as "Your account is private"). */
  aside?: ComponentChildren;
  /** The change-queue key: its pending state and its refusal show on the row. */
  s?: StageApi;
  k?: string;
  dataRow?: string;
}

/** A switch with its label and help always visible; Space and Enter toggle it (a native button). */
export function SwitchRow({ label, help, checked, onChange, aside, s, k, dataRow }: SwitchRowProps): JSX.Element {
  const id = useId();
  const pending = s !== undefined && k !== undefined && s.c.pending(k);
  return (
    <div class="set-switch-row" data-row={dataRow}>
      <div class="set-switch-row__copy">
        <span class="set-switch-row__label">
          <span id={`${id}-l`}>{label}</span>
          {aside ?? null}
        </span>
        {help ? (
          <span class="set-switch-row__help" id={`${id}-h`}>
            {help}
          </span>
        ) : null}
        {s && k ? <ControlError s={s} k={k} /> : null}
      </div>
      <button
        type="button"
        role="switch"
        class={checked ? 'set-switch is-on' : 'set-switch'}
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={help ? `${id}-h` : undefined}
        aria-busy={pending ? 'true' : undefined}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </div>
  );
}

/** Under a control whose last change was not saved: the honest one-liner (the control already reverted). */
export function ControlError({ s, k }: { s: StageApi; k: string }): JSX.Element | null {
  if (s.c.error(k) === null) return null;
  return (
    <span class="set-err" role="alert">
      {SAVE_COPY.inline}
    </span>
  );
}

/** A sub-heading inside a section ("Session style", "Follow requests"). */
export function Sub({ children }: { children: ComponentChildren }): JSX.Element {
  return <h3 class="set-sec__sub">{children}</h3>;
}
