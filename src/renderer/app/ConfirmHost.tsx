/** @jsx h */
import { h } from 'preact';
import { useEffect } from 'preact/hooks';
import type { ConfirmState } from '../hooks/useConfirm';

export interface ConfirmHostProps extends ConfirmState {
  onClose(result: boolean): void;
}

/**
 * Renders the single confirmation modal (scrim + dialog) from the confirm
 * controller's state. Backdrop click and Escape dismiss; the confirm button
 * can be styled destructive. Focus lands on the dialog while open.
 */
export function ConfirmHost({ open, title, body, confirm, dismiss, danger, onClose }: ConfirmHostProps): h.JSX.Element {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose(false);
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
      <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
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
