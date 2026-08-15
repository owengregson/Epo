/** @jsx h */
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ConfirmState } from '../hooks/useConfirm';

export interface ConfirmHostProps extends ConfirmState {
  onClose(result: boolean): void;
}

/**
 * Renders the single confirmation modal (scrim + dialog) from the confirm
 * controller's state. Backdrop click and Escape dismiss; the confirm button
 * can be styled destructive. While open, focus moves INTO the dialog and Tab
 * cycles within it (the console behind the scrim stays unreachable); on close,
 * focus returns to whatever had it. The closed scrim is `visibility:hidden`
 * (see `.scrim`), so its buttons also drop out of the tab order.
 */
export function ConfirmHost({ open, title, body, confirm, dismiss, danger, onClose }: ConfirmHostProps): h.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus into the dialog on open; restore to the prior element on close.
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => prior?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose(false);
        return;
      }
      // Trap Tab: cycle between the dialog's buttons (and re-enter the trap if
      // focus somehow sits outside the dialog).
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
        if (buttons.length === 0) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        const active = document.activeElement;
        const inside = active instanceof Node && dialog.contains(active);
        if (e.shiftKey) {
          if (!inside || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (!inside || active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <div
      class={open ? 'scrim open' : 'scrim'}
      aria-hidden={open ? 'false' : 'true'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <div class="modal-t">{title}</div>
        <div class="modal-b">{body}</div>
        <div class="modal-a">
          <button class="tbtn" type="button" onClick={() => onClose(false)}>
            {dismiss || 'Cancel'}
          </button>
          <button
            class={danger ? 'tbtn confirm-danger' : 'tbtn'}
            type="button"
            onClick={() => onClose(true)}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
