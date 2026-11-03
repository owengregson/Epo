/**
 * The column's toasts, docked above the footer: the shell's one toast stack, now with an optional action
 * (Stop's "Undo"). The live region exists before its first toast.
 */
import type { JSX } from 'preact';
import type { ToastControls } from '@/renderer/hooks/useToasts';

export function SidebarToasts({ toasts }: { toasts: ToastControls }): JSX.Element {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.toasts.map((t) => (
        <div key={t.id} class="toast" data-kind={t.kind}>
          <span class="toast__msg">{t.message}</span>
          {t.action === undefined ? null : (
            <button
              class="toast__action"
              type="button"
              onClick={() => {
                toasts.dismiss(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button class="toast__close" type="button" aria-label="Dismiss" onClick={() => toasts.dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
