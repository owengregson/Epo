/** @jsx h */
import { h } from 'preact';
import type { PruneCandidate } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { commas, monogram, withAt } from '@/renderer/lib/format';

/** Rendered-row cap — the candidate set can run to thousands (perf). */
const MAX_ROWS = 200;

/** A muted, row-aligned message line (mirrors the Queues view's note rows). */
function CandidateNote({ text }: { text: string }): h.JSX.Element {
  return (
    <div class="qr">
      <div class="qr-main">
        <div class="qr-sub">
          <span class="ctx">{text}</span>
        </div>
      </div>
    </div>
  );
}

export interface PruneCandidatesCardProps {
  /** True once a scan has completed this session (an empty list then means "all reciprocal"). */
  scanned: boolean;
  /** The VISIBLE candidate list — already derived against the live whitelist by the view. */
  candidates: PruneCandidate[];
  /** True while a scan is in flight (shows the loading note). */
  scanning: boolean;
}

/**
 * Prune · Candidates — the accounts a run would unfollow, from this session's
 * read-only scan, filtered against the LIVE whitelist (an edit hides/restores
 * rows instantly, no re-scan). Rendered rows are capped at {@link MAX_ROWS}
 * with a truncation note.
 */
export function PruneCandidatesCard({ scanned, candidates, scanning }: PruneCandidatesCardProps): h.JSX.Element {
  const shown = candidates.slice(0, MAX_ROWS);

  return (
    <Card index={1}>
      <CardHeader
        icon="users-slash"
        aux={scanned ? `${commas(candidates.length)} to prune` : undefined}
      >
        Prune · Candidates
      </CardHeader>
      <div class="qrows">
        <div class="qlist prune-list">
          {scanning ? (
            <CandidateNote text="Scanning…" />
          ) : !scanned ? (
            <CandidateNote text="Run a scan to list accounts that don’t follow you back." />
          ) : candidates.length === 0 ? (
            <CandidateNote text="Everyone you follow follows you back." />
          ) : (
            shown.map((c) => (
              <div class="qr" key={c.pk}>
                <span class="qr-av num">{monogram(c.username)}</span>
                <div class="qr-main">
                  <div class="qr-top">
                    <span class="handle">{withAt(c.username) || c.pk}</span>
                  </div>
                  <div class="qr-sub">
                    <span class="ctx">not following back</span>
                  </div>
                </div>
              </div>
            ))
          )}
          {!scanning && candidates.length > MAX_ROWS ? (
            <CandidateNote
              text={`Showing the first ${commas(MAX_ROWS)} of ${commas(candidates.length)} — the run covers them all.`}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}
