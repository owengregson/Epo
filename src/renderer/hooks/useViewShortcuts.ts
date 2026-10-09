import { useEffect } from 'preact/hooks';
import type { ViewKey } from '@/renderer/hooks/useView';

/** Nav order — ⌘/Ctrl+1 is the first entry (hints live on the nav tips). */
const KEYS: readonly ViewKey[] = ['overview', 'chain', 'queues', 'settings'];

/**
 * ⌘/Ctrl+1–4 jump between the console views. Disabled while `enabled` is false
 * (the tour owns the keyboard while it is open).
 */
export function useViewShortcuts(goTo: (key: ViewKey) => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number.parseInt(e.key, 10);
      const key = n >= 1 && n <= KEYS.length ? KEYS[n - 1] : undefined;
      if (key !== undefined) {
        e.preventDefault();
        goTo(key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, enabled]);
}
