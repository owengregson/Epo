/** @jsx h */
import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { FollowState, PeanutStatus, QueueRow } from '@/types';
import { fmtRatio, relativeTime } from '../format';

export interface QueuePanelProps {
  status: PeanutStatus | null;
}

type TimestampField = 'none' | 'followedAt' | 'holdUntil' | 'unfollowDueAt';

interface TabDef {
  state: FollowState;
  label: string;
  /** Which status field carries this tab's live count (real state — never derived). */
  count: (s: PeanutStatus) => number;
  ts: TimestampField;
  tsLabel: string;
  empty: string;
}

const TABS: TabDef[] = [
  {
    state: 'queued',
    label: 'Queued',
    count: (s) => s.queued,
    ts: 'none',
    tsLabel: '',
    empty: 'No candidates queued yet.',
  },
  {
    state: 'pending_followback',
    label: 'Awaiting',
    count: (s) => s.pendingFollowback,
    ts: 'followedAt',
    tsLabel: 'followed',
    empty: 'Nobody awaiting follow-back.',
  },
  {
    state: 'followed_back',
    label: 'Held',
    count: (s) => s.followedBackHeld,
    ts: 'holdUntil',
    tsLabel: 'hold',
    empty: 'Nothing on hold.',
  },
  {
    state: 'unfollow_queued',
    label: 'Due',
    count: (s) => s.unfollowDue,
    ts: 'unfollowDueAt',
    tsLabel: 'due',
    empty: 'Nothing due to unfollow.',
  },
];

function timestampFor(row: QueueRow, field: TimestampField): number | undefined {
  if (field === 'followedAt') return row.followedAt;
  if (field === 'holdUntil') return row.holdUntil;
  if (field === 'unfollowDueAt') return row.unfollowDueAt;
  return undefined;
}

/**
 * The lifecycle queues (spec §3), one tab per real `follow_records` state. Counts bind
 * to `EngineStatus` (no index arithmetic); rows load lazily per tab via `queue:list`,
 * capped at 100 with a truncation note. Refetches when the active tab's count moves.
 */
export function QueuePanel({ status }: QueuePanelProps): h.JSX.Element {
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  const tab = TABS[active];
  const loggedIn = status?.loggedIn ?? false;
  const activeCount = status ? tab.count(status) : 0;

  useEffect(() => {
    if (!loggedIn) {
      setRows([]);
      setTruncated(false);
      return;
    }
    let alive = true;
    setLoading(true);
    window.peanut
      .queueList(tab.state)
      .then((res) => {
        if (!alive) return;
        setRows(res.rows);
        setTruncated(res.truncated);
      })
      .catch(() => {
        if (alive) {
          setRows([]);
          setTruncated(false);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Refetch on tab change, login, and whenever this tab's real count changes.
  }, [tab.state, loggedIn, activeCount]);

  return (
    <section class="panel">
      <div class="panel__head">
        <span class="panel__title">Queues</span>
      </div>

      <div class="tabs" role="tablist">
        {TABS.map((t, i) => (
          <button
            key={t.state}
            class="tab"
            role="tab"
            aria-selected={i === active ? 'true' : 'false'}
            data-active={i === active ? 'true' : 'false'}
            onClick={() => setActive(i)}
          >
            {t.label}
            <span class="tab__count num">
              {status ? t.count(status) : 0}
            </span>
          </button>
        ))}
      </div>

      {!loggedIn ? (
        <p class="empty">Log in to load the lifecycle queues.</p>
      ) : loading && rows.length === 0 ? (
        <p class="empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p class="empty">{tab.empty}</p>
      ) : (
        <Fragment>
          <ul class="rows">
            {rows.map((row) => {
              const when = timestampFor(row, tab.ts);
              return (
                <li key={row.pk} class="row">
                  <span class="row__name">@{row.username ?? `#${row.pk}`}</span>
                  <span class="row__ratio num" title="follower / following ratio">
                    {fmtRatio(row.ratio)}
                  </span>
                  {row.isPrivate ? <span class="tag tag--sm">Private</span> : null}
                  <span class="row__spacer" />
                  {when !== undefined ? (
                    <span class="row__when">
                      {tab.tsLabel} <span class="num">{relativeTime(when)}</span>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {truncated ? (
            <p class="rows__note">Showing the first 100 of {activeCount}.</p>
          ) : null}
        </Fragment>
      )}
    </section>
  );
}
