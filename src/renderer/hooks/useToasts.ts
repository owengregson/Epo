import { useCallback, useRef, useState } from 'preact/hooks';

export type ToastKind = 'error' | 'info' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ToastControls {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

/** How long a toast lingers before auto-dismissing. */
const TOAST_TTL_MS = 6_000;

/** Most toasts shown at once — a failure burst drops the OLDEST first, so the
 * stack never climbs past the console top into the overflow clip (layout.css
 * `.toasts`), where extras would be unreadable and undismissable. */
export const TOAST_CAP = 5;

/** Pure cap step: append `next`, reporting the oldest overflow for cleanup. */
export function appendCapped(
  prev: Toast[],
  next: Toast,
  cap: number = TOAST_CAP,
): { toasts: Toast[]; dropped: Toast[] } {
  const all = prev.concat(next);
  const overflow = Math.max(0, all.length - cap);
  return { toasts: all.slice(overflow), dropped: all.slice(0, overflow) };
}

/**
 * In-VDOM toasts (§4 — no imperative DOM). Every async control surfaces its typed
 * failure through `push('error', …)`; the shell renders `toasts` declaratively. Timers
 * are tracked and cleared on dismiss so nothing fires against an unmounted tree.
 * The stack is capped at TOAST_CAP (drop-oldest) so a failure burst stays readable.
 */
export function useToasts(): ToastControls {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number): void => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string): void => {
      const id = nextId.current++;
      setToasts((prev) => {
        const { toasts: next, dropped } = appendCapped(prev, { id, kind, message });
        // Silence the auto-dismiss timers of anything the cap dropped
        // (clearTimeout is idempotent, so a re-run updater is harmless).
        for (const t of dropped) {
          const timer = timers.current.get(t.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.current.delete(t.id);
          }
        }
        return next;
      });
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
