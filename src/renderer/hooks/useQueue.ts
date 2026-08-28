import { useEffect, useRef, useState } from 'preact/hooks';
import type { EpoStatus, FollowState, QueueRow } from '@/types';

export interface QueueResult {
  rows: QueueRow[];
  truncated: boolean;
  loading: boolean;
}

/**
 * Lazily loads one lifecycle queue (`queue:list`) for the active stage, and
 * refetches when its lifecycle counts change (bind to real state, never index
 * arithmetic). Rows are capped by the main process; `truncated` flags the cut.
 *
 * Count-change refetches HOLD the previous rows (the useTargetDetail
 * hold-previous pattern) so a landed action never blanks the list for a
 * paint; only a stage switch drops them — stale rows from another stage
 * would be the wrong facts, not stale ones.
 */
export function useQueue(state: FollowState, status: EpoStatus | null): QueueResult {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const shownState = useRef<FollowState>(state);

  const countKey = status
    ? `${status.queued}|${status.pendingFollowback}|${status.followedBackHeld}|${status.unfollowDue}`
    : '';

  useEffect(() => {
    let alive = true;
    if (shownState.current !== state) {
      shownState.current = state;
      setRows([]);
      setTruncated(false);
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
  }, [state, countKey]);

  return { rows, truncated, loading };
}
