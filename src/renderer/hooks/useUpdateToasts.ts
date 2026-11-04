import { useEffect, useRef } from 'preact/hooks';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import type { UpdateStatus } from '@/shared/update-status';

/** The two update toasts; the live column's footer holds the button each one names. */
export const UPDATE_TOAST = {
  ready: (version: string): string =>
    `Epo ${version} is ready. Press Restart at the bottom of the left panel, or it installs when you quit.`,
  available: (version: string): string => `Epo ${version} is available. Press View at the bottom of the left panel.`,
} as const;

/**
 * One toast per self-updater state transition. Suppressed while `quiet` (the
 * tour runs over a quiet app); when the tour closes the effect re-runs and the
 * toast lands then, because the transition key — not a timer — is what makes
 * the toast one-shot.
 */
export function useUpdateToasts(
  update: UpdateStatus | null,
  quiet: boolean,
  toast: (kind: ToastKind, message: string) => void,
): void {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (update === null || quiet || update.version === null) return;
    const key = `${update.state}:${update.version}`;
    if (shown.current === key) return;
    if (update.state === 'ready') {
      shown.current = key;
      toast('info', UPDATE_TOAST.ready(update.version));
    } else if (update.state === 'available' && update.mode === 'notify') {
      shown.current = key;
      toast('info', UPDATE_TOAST.available(update.version));
    }
  }, [update, quiet, toast]);
}
