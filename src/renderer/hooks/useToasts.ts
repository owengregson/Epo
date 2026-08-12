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

/**
 * In-VDOM toasts (§4 — no imperative DOM). Every async control surfaces its typed
 * failure through `push('error', …)`; the shell renders `toasts` declaratively. Timers
 * are tracked and cleared on dismiss so nothing fires against an unmounted tree.
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
      setToasts((prev) => prev.concat({ id, kind, message }));
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
