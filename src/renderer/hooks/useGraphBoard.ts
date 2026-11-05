import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { graphPreloadedSignal } from '@/renderer/app/live-signals';
import { statusSignal } from '@/renderer/app/shell-context';
import type { GraphNodeStatus, GraphSnapshot } from '@/types';

/** Minimum ms between snapshot fetches while mutations stream (trailing). */
const REFRESH_MIN_MS = 1500;
/** Idle safety refresh so timer-progress saturation drifts even without writes. */
const IDLE_REFRESH_MS = 60_000;

export interface GraphBoard {
  snapshot: GraphSnapshot | null;
  loading: boolean;
  unavailable: boolean;
  retry(): void;
  hidden: ReadonlySet<GraphNodeStatus>;
  toggleStatus(status: GraphNodeStatus): void;
}

/** Preload the stored graph behind the splash; later reads follow mutations only while Graph is visible. */
export function useGraphBoard(active: boolean): GraphBoard {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<GraphNodeStatus>>(new Set());
  const activeNow = useRef(active);
  activeNow.current = active;
  const wasActive = useRef(active);
  const request = useRef<() => void>(() => undefined);
  const pause = useRef<() => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let dirty = false;
    let lastFetchAt = 0;
    let hasSnapshot = false;
    let awaitingBuilt = false;
    let timer: number | null = null;
    const schedule = (): void => {
      if (!activeNow.current || timer !== null) return;
      const wait = Math.max(0, lastFetchAt + REFRESH_MIN_MS - Date.now());
      timer = window.setTimeout(() => { timer = null; fetchNow(); }, wait);
    };
    const fetchNow = (): void => {
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      lastFetchAt = Date.now();
      const builtAtRequest = statusSignal.peek()?.basis === 'built';
      setLoading(!hasSnapshot);
      window.epo.graphSnapshot().then(
        (next) => {
          if (!alive) return;
          if (next !== null && 'unavailable' in next) { awaitingBuilt = false; setUnavailable(true); return; }
          awaitingBuilt = next === null && !builtAtRequest;
          hasSnapshot = next !== null;
          setSnapshot(next);
          setUnavailable(false);
        },
        () => { awaitingBuilt = false; if (alive) setUnavailable(true); },
      ).finally(() => {
        if (!alive) return;
        inFlight = false;
        setLoading(false);
        if (awaitingBuilt) {
          const status = statusSignal.peek();
          if (status?.basis === 'built') { fetchNow(); return; }
          if (status?.loggedIn === false || status?.boot?.data === 'unavailable') awaitingBuilt = false;
        }
        graphPreloadedSignal.value = !awaitingBuilt;
        if (dirty) { dirty = false; schedule(); }
      });
    };
    const cancelScheduled = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      dirty = false;
    };
    request.current = fetchNow;
    pause.current = cancelScheduled;
    fetchNow();
    let firstStatus = true;
    const offStatus = statusSignal.subscribe((status) => {
      if (awaitingBuilt && !inFlight) {
        if (status?.basis === 'built') { fetchNow(); return; }
        if (status?.loggedIn === false || status?.boot?.data === 'unavailable') {
          awaitingBuilt = false;
          graphPreloadedSignal.value = true;
        }
      }
      if (!firstStatus) schedule();
      firstStatus = false;
    });
    const idle = window.setInterval(schedule, IDLE_REFRESH_MS);
    return () => {
      alive = false;
      request.current = () => undefined;
      pause.current = () => undefined;
      offStatus();
      window.clearInterval(idle);
      cancelScheduled();
    };
  }, []);

  // The fetch lifetime spans stage changes, so activation during preload queues a refresh instead of losing it.
  useEffect(() => {
    if (active && !wasActive.current) request.current();
    if (!active) pause.current();
    wasActive.current = active;
  }, [active]);

  const retry = useCallback(() => request.current(), []);
  const toggleStatus = useCallback((status: GraphNodeStatus): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);
  return { snapshot, loading, unavailable, retry, hidden, toggleStatus };
}
