/** @jsx h */
import { h } from 'preact';
import type { PruneScanResult } from '@/types';
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
  /** This session's scan result; null until a scan has completed. */
  scan: PruneScanResult | null;
  /** True while a scan is in flight (shows the loading note). */
  scanning: boolean;
}

/**
 * Prune · Candidates — the accounts a run would unfollow, from this session's
 * read-only scan. Rendered rows are capped at {@link MAX_ROWS} with a
 * truncation note; whitelisted accounts are already excluded by the scan.
 */
export function PruneCandidatesCard({ scan, scanning }: PruneCandidatesCardProps): h.JSX.Element {
  const candidates = scan?.candidates ?? [];
  const shown = candidates.slice(0, MAX_ROWS);

  return (
    <Card index={2}>
      <CardHeader
        icon="users-slash"
        aux={scan !== null ? `${commas(candidates.length)} to prune` : undefined}
      >
        Prune · Candidates
      </CardHeader>
      <div class="qrows">
        <div class="qlist prune-list">
          {scanning ? (
            <CandidateNote text="Scanning…" />
          ) : scan === null ? (
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
