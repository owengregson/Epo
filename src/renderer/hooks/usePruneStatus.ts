import { useEffect, useRef, useState } from 'preact/hooks';
import type { PruneStatus } from '@/types';

/** How stale the last update may get before the keep-alive pull fires (§4). */
const KEEPALIVE_MS = 10_000;

/**
 * The single source of prune status for the Prune view (§4 — push-first).
 * Mirrors {@link useEngineStatus}: subscribes to pushed `pruneStatus`, does
 * exactly ONE `pruneStatus()` pull on mount, and runs a slow keep-alive that
 * pulls ONLY when no push has arrived within the window — so it never fights
 * the push stream. The listener and the interval are both torn down on unmount.
 */
export function usePruneStatus(): PruneStatus | null {
  const [status, setStatus] = useState<PruneStatus | null>(null);
  const lastUpdateAt = useRef(0);

  useEffect(() => {
    let alive = true;
    const apply = (s: PruneStatus): void => {
      if (!alive) return;
      lastUpdateAt.current = Date.now();
      setStatus(s);
    };

    const onStatus = (s: PruneStatus): void => apply(s);
    window.epo.on('pruneStatus', onStatus);

    // One pull on mount so the first paint reflects real state.
    window.epo
      .pruneStatus()
      .then(apply)
      .catch(() => {
        // best-effort; a push or the keep-alive will fill this in
      });

    // Fallback only: pull when the pushed stream has gone quiet, never on a cadence
    // that would overwrite fresh pushes.
    const keepalive = window.setInterval(() => {
      if (Date.now() - lastUpdateAt.current < KEEPALIVE_MS) return;
      window.epo
        .pruneStatus()
        .then(apply)
        .catch(() => {});
    }, KEEPALIVE_MS);

    return () => {
      alive = false;
      window.clearInterval(keepalive);
      window.epo.off('pruneStatus', onStatus);
    };
  }, []);

  return status;
}
