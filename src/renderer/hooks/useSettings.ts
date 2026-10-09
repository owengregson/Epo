import { useEffect } from 'preact/hooks';
import { settingsSignal } from '@/renderer/app/shell-context';

/**
 * The canonical settings object: one read on mount (no push channel exists for
 * settings), published on {@link settingsSignal}. Called once, by the shell —
 * a second copy of this in a view can disagree with the first. Saves report
 * back through `adoptSettings` (the shell's `onSaved`).
 */
export function useSettings(): void {
  useEffect(() => {
    let alive = true;
    window.epo
      .getSettings()
      .then((s) => {
        if (alive) settingsSignal.value = s;
      })
      .catch(() => {
        /* the Settings view shows its own loading state */
      });
    return () => {
      alive = false;
    };
  }, []);
}
