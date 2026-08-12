import { useEffect, useRef, useState } from 'preact/hooks';
import type { PeanutStatus } from '@/types';

/** How stale the last update may get before the keep-alive pull fires (§4). */
const KEEPALIVE_MS = 10_000;

/**
 * The single source of engine status for the whole shell (§4 — push-first).
 *
 * Subscribes to pushed `status`, does exactly ONE `status()` pull on mount, and runs
 * a slow keep-alive that pulls ONLY when no push has arrived within the window — so it
 * never fights the push stream (the old renderer's flicker bug). The listener and the
 * interval are both torn down on unmount (no leaks).
 */
export function useEngineStatus(): PeanutStatus | null {
  const [status, setStatus] = useState<PeanutStatus | null>(null);
  const lastUpdateAt = useRef(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: PeanutStatus): void => {
      if (!alive) return;
      lastUpdateAt.current = Date.now();
      setStatus(s);
    };

    const onStatus = (s: PeanutStatus): void => apply(s);
    window.peanut.on('status', onStatus);

    // One pull on mount so the first paint reflects real state.
    window.peanut
      .status()
      .then(apply)
      .catch(() => {
        // best-effort; a push or the keep-alive will fill this in
      });

    // Fallback only: pull when the pushed stream has gone quiet, never on a cadence
    // that would overwrite fresh pushes.
    const keepalive = window.setInterval(() => {
      if (Date.now() - lastUpdateAt.current < KEEPALIVE_MS) return;
      window.peanut
        .status()
        .then(apply)
        .catch(() => {});
    }, KEEPALIVE_MS);

    return () => {
      alive = false;
      window.clearInterval(keepalive);
      window.peanut.off('status', onStatus);
    };
  }, []);

  return status;
}
