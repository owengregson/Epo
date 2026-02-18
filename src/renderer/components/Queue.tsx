import { h, Fragment } from 'preact';
import type { BotStatus, FollowerEntry } from '../../types';
import type { QueueTab } from '../hooks/useBot';

interface Props {
  queueTab: QueueTab;
  setQueueTab: (t: QueueTab) => void;
  status: BotStatus;
  followers: FollowerEntry[];
  nextFollowIndex: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function FollowersList({ followers, nextFollowIndex, status }: { followers: FollowerEntry[]; nextFollowIndex: number; status: BotStatus }) {
  if (followers.length === 0) {
    return (
      <div class="empty-state">
        <i class="fa-solid fa-users" />
        <h3>No followers scraped</h3>
        <p>Start a scrape from the Dashboard to collect followers from the target account.</p>
      </div>
    );
  }

  const progressPct = followers.length > 0
    ? Math.min(100, Math.round((nextFollowIndex / followers.length) * 100))
    : 0;

  const rows = followers.slice(0, 200).map((f, idx) => {
    let statusBadge;
    if (idx < nextFollowIndex) {
      statusBadge = <span class="badge badge-done"><i class="fa-solid fa-check" /> Done</span>;
    } else if (idx < nextFollowIndex + status.queuedFollows) {
      statusBadge = <span class="badge badge-queued"><i class="fa-solid fa-clock" /> Queued</span>;
    } else {
      statusBadge = <span class="badge badge-pending">Pending</span>;
    }

    return (
      <tr key={f.username}>
        <td style="color: var(--text-muted); width: 50px;">{idx + 1}</td>
        <td class="username">
          @{escapeHtml(f.username)}
          {f.isVerified && <> <i class="fa-solid fa-circle-check badge-verified" /></>}
        </td>
        <td>{f.fullName || '--'}</td>
        <td>{statusBadge}</td>
      </tr>
    );
  });

  return (
    <>
      <div class="follower-list-meta">
        <span>{followers.length} followers collected</span>
        <div class="follower-list-progress">
          <span>{progressPct}% processed</span>
          <div class="progress-bar"><div class="progress-bar-fill" style={`width: ${progressPct}%`} /></div>
        </div>
      </div>
      <div class="panel-body-flush">
        <table class="data-table">
          <thead><tr>
            <th>#</th><th>Username</th><th>Name</th><th>Status</th>
          </tr></thead>
          <tbody>{rows}</tbody>
        </table>
      </div>
      {followers.length > 200 && (
        <div style="padding: 12px 18px; font-size: 12px; color: var(--text-muted);">
          Showing first 200 of {followers.length}
        </div>
      )}
    </>
  );
}

function ScheduledList({ status }: { status: BotStatus }) {
  if (status.queuedFollows === 0) {
    return (
      <div class="empty-state">
        <i class="fa-solid fa-clock" />
        <h3>No scheduled follows</h3>
        <p>Start the bot to generate today's follow schedule.</p>
      </div>
    );
  }

  const nextTime = status.nextFollowAt
    ? new Date(status.nextFollowAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--';

  return (
    <div class="panel-body">
      <p style="color: var(--text-secondary); font-size: 13px;">
        <strong>{status.queuedFollows}</strong> follows scheduled.
        Next at <strong>{nextTime}</strong>.
      </p>
    </div>
  );
}

function UnfollowsList({ status }: { status: BotStatus }) {
  if (status.pendingUnfollows === 0) {
    return (
      <div class="empty-state">
        <i class="fa-solid fa-user-minus" />
        <h3>No pending unfollows</h3>
        <p>Unfollows are scheduled automatically after following.</p>
      </div>
    );
  }

  const nextTime = status.nextUnfollowAt
    ? new Date(status.nextUnfollowAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--';

  return (
    <div class="panel-body">
      <p style="color: var(--text-secondary); font-size: 13px;">
        <strong>{status.pendingUnfollows}</strong> unfollows pending.
        Next at <strong>{nextTime}</strong>.
      </p>
    </div>
  );
}

export function Queue({ queueTab, setQueueTab, status, followers, nextFollowIndex }: Props) {
  const tabs: { id: QueueTab; label: string; count: number }[] = [
    { id: 'followers', label: 'Followers', count: followers.length },
    { id: 'scheduled', label: 'Scheduled', count: status.queuedFollows },
    { id: 'unfollows', label: 'Unfollows', count: status.pendingUnfollows },
  ];

  let content;
  switch (queueTab) {
    case 'followers':
      content = <FollowersList followers={followers} nextFollowIndex={nextFollowIndex} status={status} />;
      break;
    case 'scheduled':
      content = <ScheduledList status={status} />;
      break;
    case 'unfollows':
      content = <UnfollowsList status={status} />;
      break;
  }

  return (
    <div class="panel">
      <div class="queue-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            class={`queue-tab ${queueTab === t.id ? 'active' : ''}`}
            onClick={() => setQueueTab(t.id)}
          >
            {t.label}<span class="queue-count">{t.count}</span>
          </button>
        ))}
      </div>
      {content}
    </div>
  );
}
