import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { PruneCandidateView } from '@/ipc/contract';
import { monogram, withAt } from '@/renderer/lib/format';
import { fill } from '@/renderer/settings/format';
import { Badge } from '@/renderer/ui/Badge';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Icon } from '@/renderer/ui/Icon';
import { PROTECTED_WHY, PRUNE_COPY } from './prune-copy';

/** Rendered-row cap — the candidate set can run to thousands (perf). */
const MAX_ROWS = 200;

/** A muted, row-aligned message line (mirrors the Queues view's note rows). */
function CandidateNote({ text, action }: { text: string; action?: { label: string; run(): void } }): JSX.Element {
  return (
    <div class="qr">
      <div class="qr-main">
        <div class="qr-sub">
          <span class="ctx">{text}</span>
          {action ? (
            <button type="button" class="link-btn" onClick={action.run}>
              {action.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ c }: { c: PruneCandidateView }): JSX.Element {
  return (
    <div class="qr">
      <span class="qr-av num">{monogram(c.username)}</span>
      <div class="qr-main">
        <div class="qr-top">
          <span class="handle">{withAt(c.username) || c.pk}</span>
          {c.protectedBy !== null ? (
            <Badge>
              <Icon name="shield-halved" /> {fill(PRUNE_COPY.protectedBadge, { why: PROTECTED_WHY[c.protectedBy] })}
            </Badge>
          ) : null}
        </div>
        <div class="qr-sub">
          <span class="ctx">{c.bioUnread ? PRUNE_COPY.bioUnread : PRUNE_COPY.notFollowingBack}</span>
        </div>
      </div>
    </div>
  );
}

export interface PruneCandidatesCardProps {
  /** The saved census's unvisited candidates, annotated by protection in main; null before any census. */
  rows: readonly PruneCandidateView[] | null;
  /** True while a scan is in flight (shows the loading note). */
  scanning: boolean;
  /** The saved list could not be read although the census says it has rows. */
  failed: boolean;
  onRetry(): void;
}

/**
 * Prune · Candidates — the accounts a run would unfollow, as main annotates them: protected accounts are
 * hidden behind "Show protected (N)" and carry the rule that keeps them; an unread bio says it is checked
 * before any unfollow. Rendered rows are capped with a note.
 */
export function PruneCandidatesCard({ rows, scanning, failed, onRetry }: PruneCandidatesCardProps): JSX.Element {
  const [showProtected, setShowProtected] = useState(false);
  const all = rows ?? [];
  const open = all.filter((c) => c.protectedBy === null);
  const kept = all.length - open.length;
  const listed = showProtected ? all : open;
  const shown = listed.slice(0, MAX_ROWS);
  return (
    <Card>
      <CardHeader icon="users-slash" aux={rows !== null ? fill(PRUNE_COPY.toPrune, { n: open.length }) : undefined}>
        {PRUNE_COPY.candidates}
      </CardHeader>
      <div class="qrows">
        {kept > 0 ? (
          <button type="button" class="link-btn" aria-pressed={showProtected} onClick={() => setShowProtected(!showProtected)}>
            {showProtected ? PRUNE_COPY.hideProtected : fill(PRUNE_COPY.showProtected, { n: kept })}
          </button>
        ) : null}
        <div class="qlist prune-list">
          {scanning ? (
            <CandidateNote text={PRUNE_COPY.scanning} />
          ) : failed ? (
            <CandidateNote text={PRUNE_COPY.listFailed} action={{ label: PRUNE_COPY.tryAgain, run: onRetry }} />
          ) : rows === null ? (
            <CandidateNote text={PRUNE_COPY.scanFirst} />
          ) : listed.length === 0 ? (
            <CandidateNote text={PRUNE_COPY.everyone} />
          ) : (
            shown.map((c) => <Row key={c.pk} c={c} />)
          )}
          {!scanning && listed.length > MAX_ROWS ? (
            <CandidateNote text={fill(PRUNE_COPY.capped, { max: MAX_ROWS, n: listed.length })} />
          ) : null}
        </div>
      </div>
    </Card>
  );
}
