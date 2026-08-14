import { useEffect, useRef, useState } from 'preact/hooks';
import { POLL } from '@/timing/config';

/**
 * Push-first status subscription with a quiet-stream fallback (§4): subscribe to
 * the pushed channel, do exactly ONE pull on mount, and pull again ONLY when no
 * push has arrived within the keep-alive window — never on a cadence that would
 * overwrite fresh pushes (the old renderer's flicker bug). The one
 * implementation behind useEngineStatus and usePruneStatus (formerly
 * byte-identical copies). Listener and interval are torn down on unmount.
 */
export function useKeepAlivePoll<T>(opts: {
  subscribe: (apply: (v: T) => void) => () => void;
  pull: () => Promise<T>;
}): T | null {
  const [value, setValue] = useState<T | null>(null);
  const lastUpdateAt = useRef(0);
  // Pin the first render's opts: the effect runs once, and the callers' inline
  // closures capture nothing mutable.
  const optsRef = useRef(opts);

  useEffect(() => {
    let alive = true;
    const { subscribe, pull } = optsRef.current;
    const apply = (v: T): void => {
      if (!alive) return;
      lastUpdateAt.current = Date.now();
      setValue(v);
    };
    const unsubscribe = subscribe(apply);
    // One pull on mount so the first paint reflects real state.
    pull()
      .then(apply)
      .catch(() => {
        // best-effort; a push or the keep-alive will fill this in
      });
    const keepalive = window.setInterval(() => {
      if (Date.now() - lastUpdateAt.current < POLL.KEEPALIVE_MS) return;
      pull()
        .then(apply)
        .catch(() => {});
    }, POLL.KEEPALIVE_MS);
    return () => {
      alive = false;
      window.clearInterval(keepalive);
      unsubscribe();
    };
  }, []);

  return value;
}
