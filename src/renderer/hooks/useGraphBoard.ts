import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { GraphNodeStatus, GraphSnapshot } from '@/types';

/** Minimum ms between snapshot fetches while mutations stream (trailing). */
const REFRESH_MIN_MS = 1500;
/** Idle safety refresh so timer-progress saturation drifts even without writes. */
const IDLE_REFRESH_MS = 60_000;

export interface GraphBoard {
  snapshot: GraphSnapshot | null;
  /** True only before the FIRST snapshot resolves (refreshes are silent). */
  loading: boolean;
  /** Statuses the canvas currently hides (legend toggles). */
  hidden: ReadonlySet<GraphNodeStatus>;
  toggleStatus(status: GraphNodeStatus): void;
}

/**
 * The Graph view's data source, shared by the sidebar legend and the canvas
 * stage. Liveness comes from the ONE mutation mechanism (docs/PRINCIPLES.md
 * §2): every pushed `status` projection marks the snapshot dirty and a
 * trailing-coalesced refetch (≥{@link REFRESH_MIN_MS} apart) redraws the
 * canvas — so clusters visibly grow WHILE a scan streams rows. Nothing is
 * fetched while the view is closed; opening it fetches fresh.
 */
export function useGraphBoard(active: boolean): GraphBoard {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<GraphNodeStatus>>(new Set());

  const lastFetchAt = useRef(0);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;

    const fetchNow = (): void => {
      if (inFlight.current) {
        dirty.current = true; // a push landed mid-fetch — go again after
        return;
      }
      inFlight.current = true;
      lastFetchAt.current = Date.now();
      window.epo
        .graphSnapshot()
        .then((snap) => {
          if (!alive) return;
          setSnapshot(snap);
          setLoading(false);
        })
        .catch(() => {
          if (alive) setLoading(false);
        })
        .finally(() => {
          inFlight.current = false;
          if (alive && dirty.current) {
            dirty.current = false;
            schedule();
          }
        });
    };

    const schedule = (): void => {
      if (timer.current !== null) return; // trailing refetch already booked
      const wait = Math.max(0, lastFetchAt.current + REFRESH_MIN_MS - Date.now());
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fetchNow();
      }, wait);
    };

    // Every pushed status projection rides a store mutation — that push IS the
    // "graph changed" signal, so refreshing on it keeps the canvas live.
    const onPush = (): void => schedule();

    setLoading(snapshot === null);
    fetchNow();
    window.epo.on('status', onPush);
    const idle = window.setInterval(schedule, IDLE_REFRESH_MS);

    return () => {
      alive = false;
      window.epo.off('status', onPush);
      window.clearInterval(idle);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      dirty.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const toggleStatus = useCallback((status: GraphNodeStatus): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  return { snapshot, loading, hidden, toggleStatus };
}
