import type { Signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { POLL } from '@/timing/config';

/**
 * Push-first status subscription with a quiet-stream fallback: subscribe to
 * the pushed channel, do exactly ONE pull on mount, and pull again ONLY when no
 * push has arrived within the keep-alive window — never on a cadence that would
 * overwrite fresh pushes (the old renderer's flicker bug). The one
 * implementation behind useEngineStatus and usePruneStatus (formerly
 * byte-identical copies). Listener and interval are torn down on unmount.
 *
 * The value lands in a SIGNAL (`sink`), not component state: the subscription
 * is the shell's, but the re-render belongs to whoever actually reads the
 * projection. Nothing else about the §2 contract moved.
 */
export function useKeepAlivePoll<T>(opts: {
  subscribe: (apply: (v: T) => void) => () => void;
  pull: () => Promise<T>;
  /** Where the projection is published. */
  sink: Signal<T | null>;
  /** A failed pull (the mount pull or a keep-alive pull); without it a failure waits for the next push. */
  onError?: (error: unknown) => void;
}): void {
  const lastUpdateAt = useRef(0);
  // Pin the first render's opts: the effect runs once, and the callers' inline
  // closures capture nothing mutable.
  const optsRef = useRef(opts);

  useEffect(() => {
    let alive = true;
    const { subscribe, pull, sink, onError } = optsRef.current;
    const failed = (error: unknown): void => {
      if (alive) onError?.(error);
    };
    const apply = (v: T): void => {
      if (!alive) return;
      lastUpdateAt.current = Date.now();
      sink.value = v;
    };
    const unsubscribe = subscribe(apply);
    // One pull on mount so the first paint reflects real state.
    pull().then(apply).catch(failed);
    const keepalive = window.setInterval(() => {
      if (Date.now() - lastUpdateAt.current < POLL.KEEPALIVE_MS) return;
      pull().then(apply).catch(failed);
    }, POLL.KEEPALIVE_MS);
    return () => {
      alive = false;
      window.clearInterval(keepalive);
      unsubscribe();
    };
  }, []);
}
