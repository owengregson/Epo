import { useEffect, useRef } from 'preact/hooks';
import { statusSignal } from '@/renderer/app/shell-context';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import type { EpoStatus } from '@/types';

/** How long an armed watch stays meaningful — a first-thing park registers in seconds. */
const WATCH_TTL_MS = 90_000;

/**
 * One-shot Start watch: pressing Start outside the activity window otherwise
 * yields hours of silence. `arm()` records the engine's step markers at press
 * time; the next pushed statuses are inspected — the first one carrying a
 * window park gets the toast, and any other sign of the engine at work (a
 * different park, a step marker moving) disarms silently.
 *
 * The status object present at arm time is captured and skipped: at press time
 * the engine is still `idle`, which is also the "start refused" signal, so
 * without the skip the watch disarms on its own arming render.
 *
 * It watches {@link statusSignal} directly, so the shell never has to read
 * status (and re-render the whole tree) to keep this watch fed. `subscribe` —
 * NOT `useSignalEffect` — because the watch must see EVERY pushed status:
 * signal-effect re-runs are batched into an animation frame, which would
 * collapse two pushes into one and swallow the disarming one.
 *
 * @returns `arm` — call it from the Start handler, before the control runs.
 */
export function useStartWatch(toast: (kind: ToastKind, message: string) => void): () => void {
  const armed = useRef<{
    at: EpoStatus | null;
    lastStep: EpoStatus['lastStep'];
    lastActionAt: number | null;
    armedAt: number;
  } | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  useEffect(
    () =>
      statusSignal.subscribe((status) => {
        const a = armed.current;
        if (a === null || status === null || status === a.at) return;
        if (Date.now() - a.armedAt > WATCH_TTL_MS) {
          armed.current = null; // stale — whatever happens now is not "at Start"
          return;
        }
        if (status.state === 'idle' || status.state === 'halted') {
          armed.current = null; // start refused, failed, or already over
          return;
        }
        const reason = status.parkReason ?? null;
        const until = status.parkedUntil ?? null;
        if ((reason === 'active-hours' || reason === 'session') && until != null) {
          armed.current = null;
          const d = new Date(until);
          toastRef.current(
            'info',
            `Started — first actions at ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}.`,
          );
          return;
        }
        if (
          reason != null ||
          status.lastStep !== a.lastStep ||
          status.lastActionAt !== a.lastActionAt
        ) {
          armed.current = null; // the engine went to work — no hold toast owed
        }
      }),
    [],
  );

  return () => {
    const now = statusSignal.peek();
    armed.current = {
      at: now,
      lastStep: now?.lastStep ?? null,
      lastActionAt: now?.lastActionAt ?? null,
      armedAt: Date.now(),
    };
  };
}
