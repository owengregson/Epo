import { useEffect, useState } from 'preact/hooks';
import type { Settings } from '@/types';

/** One read-only settings pull on mount (no push channel exists for settings). */
export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    window.epo
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return settings;
}
