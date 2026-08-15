import { useEffect, useState } from 'preact/hooks';

/**
 * A shared wall-clock tick: returns `Date.now()`, refreshed every `intervalMs`
 * while `active`. With `active` false the interval stops and the value HOLDS at
 * its last tick (e.g. session uptime freezing while the engine is paused).
 * Re-activation re-syncs immediately, so a held clock never shows a stale jump.
 */
export function useNow(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}
