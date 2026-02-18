import { h, Fragment } from 'preact';
import type { BotStatus } from '../../types';

interface Props {
  status: BotStatus;
}

function formatTime(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Dashboard({ status: s }: Props) {
  let bannerClass = 'idle';
  let bannerIcon = 'fa-circle-pause';
  let bannerText = s.lastAction;
  if (s.busy) {
    bannerClass = 'busy';
    bannerIcon = 'fa-spinner fa-spin';
  } else if (s.running) {
    bannerClass = 'running';
    bannerIcon = 'fa-circle-play';
  }

  return (
    <>
      <div class={`status-banner ${bannerClass}`}>
        <i class={`fa-solid ${bannerIcon}`} />
        <span>{bannerText}</span>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label"><i class="fa-solid fa-bullseye" /> Target</div>
          <div class="stat-value" style="font-size: 16px;">{s.target || '--'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label"><i class="fa-solid fa-database" /> Scraped</div>
          <div class="stat-value">{s.followerCount}</div>
          <div class="stat-meta">{s.scrapeProgress?.isComplete ? 'Complete' : 'followers collected'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label"><i class="fa-solid fa-user-plus" /> Queued</div>
          <div class="stat-value">{s.queuedFollows}</div>
          <div class="stat-meta">Next: {formatTime(s.nextFollowAt)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label"><i class="fa-solid fa-user-minus" /> Unfollows</div>
          <div class="stat-value">{s.pendingUnfollows}</div>
          <div class="stat-meta">Next: {formatTime(s.nextUnfollowAt)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label"><i class="fa-solid fa-forward" /> Progress</div>
          <div class="stat-value">{s.nextFollowIndex}</div>
          <div class="stat-meta">of {s.followerCount} processed</div>
        </div>
      </div>

      {!s.target && (
        <div class="empty-state" style="margin-top: 32px;">
          <i class="fa-solid fa-gear" />
          <h3>No target configured</h3>
          <p>Go to Settings to set a target username before starting.</p>
        </div>
      )}
    </>
  );
}
