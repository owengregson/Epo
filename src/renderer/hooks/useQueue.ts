import { useEffect, useRef, useState } from 'preact/hooks';
import type { EpoStatus, FollowState, QueueListResult, QueueRow } from '@/types';

export interface QueueResult {
  rows: QueueRow[];
  truncated: boolean;
  loading: boolean;
}

/**
 * One lifecycle lane (`queue:list`), refetched when its lifecycle counts change
 * (bind to real state, never index arithmetic) and only while `active` (the
 * page is shown). `preloaded` is the page the shell fetched before the reveal,
 * so a lane renders at once when it opens. Rows are capped by main;
 * `truncated` flags the cut.
 *
 * Count-change refetches HOLD the previous rows, so a landed action never
 * blanks the list for a paint; a lane switch shows that lane's preloaded rows
 * (or none) — another lane's rows would be the wrong facts, not stale ones.
 */
export function useQueue(
  state: FollowState,
  status: EpoStatus | null,
  active = true,
  preloaded: QueueListResult | null = null,
): QueueResult {
  const [rows, setRows] = useState<QueueRow[]>(preloaded?.rows ?? []);
  const [truncated, setTruncated] = useState(preloaded?.truncated ?? false);
  const [loading, setLoading] = useState(preloaded === null);
  const shownState = useRef<FollowState>(state);

  const countKey = status
    ? `${status.queued}|${status.pendingFollowback}|${status.followedBackHeld}|${status.unfollowDue}`
    : '';

  useEffect(() => {
    if (!active) return;
    let alive = true;
    if (shownState.current !== state) {
      shownState.current = state;
      setRows(preloaded?.rows ?? []);
      setTruncated(preloaded?.truncated ?? false);
    }
    setLoading(true);
    window.epo
      .queueList(state)
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setTruncated(r.truncated);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // `preloaded` only seeds a lane switch; a new object alone must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, countKey, active]);

  return { rows, truncated, loading };
}
