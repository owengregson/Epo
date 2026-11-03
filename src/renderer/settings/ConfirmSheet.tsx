import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

export interface SheetAction {
  readonly label: string;
  run(): void;
  readonly tone?: 'primary' | 'danger' | 'plain';
}

export interface ConfirmSheetProps {
  title: string;
  children: ComponentChildren;
  actions: readonly SheetAction[];
  /** Esc, or the plain way out. */
  onCancel(): void;
}

/**
 * A confirm sheet that opens in place under the control that asked (the cleanup opt-in, the reset diff): it
 * can carry lists and more than two answers, which the one shell modal cannot. Focus moves into it; Esc
 * cancels; nothing is sent until an answer is pressed.
 */
export function ConfirmSheet({ title, children, actions, onCancel }: ConfirmSheetProps): JSX.Element {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => prior?.focus();
  }, []);
  return (
    <div
      class="set-sheet"
      role="alertdialog"
      aria-labelledby={`${id}-t`}
      aria-describedby={`${id}-b`}
      tabIndex={-1}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p class="set-sheet__title" id={`${id}-t`}>
        {title}
      </p>
      <div class="set-sheet__body" id={`${id}-b`}>
        {children}
      </div>
      <div class="set-sheet__actions">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            class={a.tone === 'primary' ? 'set-btn set-btn--primary' : a.tone === 'danger' ? 'set-btn set-btn--danger' : 'set-btn'}
            onClick={a.run}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
