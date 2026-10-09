import { useEffect, useRef } from 'preact/hooks';
import type { ToastKind } from '@/renderer/hooks/useToasts';
import type { UpdateStatus } from '@/types';

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
    if (update === null || quiet) return;
    const key = `${update.state}:${update.version ?? ''}`;
    if (shown.current === key) return;
    if (update.state === 'ready') {
      shown.current = key;
      toast(
        'info',
        `Epo v${update.version} is downloaded — restart from Settings → Updates, or it installs when you quit.`,
      );
    } else if (update.state === 'available' && update.mode === 'notify') {
      shown.current = key;
      toast('info', `Epo v${update.version} is available — see Settings → Updates.`);
    }
  }, [update, quiet, toast]);
}
