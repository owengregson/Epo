/** @jsx h */
import { h } from 'preact';
import type { PruneScanResult, PruneStatus } from '@/types';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { Card, CardHeader, CardBody } from '@/renderer/ui/Card';
import { Button } from '@/renderer/ui/Button';
import { Stat } from '@/renderer/ui/Stat';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { NumberTicker } from '@/renderer/ui/NumberTicker';
import { commas, shortDate } from '@/renderer/lib/format';

/** Epoch ms → coarse relative phrase ("3h ago"); falls back to a short date. */
function relTime(atMs: number): string {
  const mins = Math.floor(Math.max(0, Date.now() - atMs) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days}d ago` : shortDate(atMs);
}

export interface PruneScanCardProps {
  /** Live prune projection (carries the last persisted scan's counts). */
  prune: PruneStatus | null;
  /** This session's scan result, when one has completed. */
  scan: PruneScanResult | null;
  /** True while this view's `scanPrune()` call is in flight. */
  scanning: boolean;
  /** Growth engine actively running — scanning will pause it, then resume it. */
  growthRunning: boolean;
  /** True while the view's `stopPrune()` call is in flight. */
  stopping: boolean;
  onScan(): void;
  /** Halt the active scan (already confirmed by this card). */
  onStop(): void;
  /** The shell's confirm modal — gates every stop. */
  confirm(options: ConfirmOptions): Promise<boolean>;
}

/**
 * Prune · Scan — the read-only census. One button walks the full following +
 * followers lists and reports Following / Followers / Not-following-back, plus
 * today's prune-ledger spend and when the last run completed. While a scan is
 * live (pushed `state === 'scanning'`) the same button becomes a confirm-gated
 * Stop. Nothing here unfollows; the run controls live in {@link PruneRunCard}.
 */
export function PruneScanCard({
  prune,
  scan,
  scanning,
  growthRunning,
  stopping,
  onScan,
  onStop,
  confirm,
}: PruneScanCardProps): h.JSX.Element {
  // Scan is live off the PUSHED state (so the Stop affordance covers scheduled
  // scans too), with the local flag bridging the gap before the first push.
  const isScanning = scanning || prune?.state === 'scanning';

  // While a scan is LIVE the pushed projection carries the mid-scrape counts —
  // prefer it over a previous session's cached scan so the numbers tick up in
  // real time. Otherwise prefer this session's scan, then the persisted counts.
  const following =
    (isScanning ? prune?.following : undefined) ?? scan?.following ?? prune?.following ?? 0;
  const followers =
    (isScanning ? prune?.followers : undefined) ?? scan?.followers ?? prune?.followers ?? 0;
  const candidates =
    !isScanning && scan !== null ? scan.candidates.length : (prune?.candidates ?? 0);
  const scannedEver =
    isScanning ||
    scan !== null ||
    (prune !== null && (prune.following > 0 || prune.followers > 0));
  const pruneRunning = prune?.state === 'running';
  const busy = isScanning || pruneRunning;

  const onStopScan = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Stop the scan?',
      body: 'The scan halts between scroll rounds — run it again any time for a fresh census.',
      confirm: 'Stop scan',
      dismiss: 'Keep scanning',
      danger: true,
    });
    if (ok) onStop();
  };

  const dailyDone = prune?.dailyDone ?? 0;
  const dailyLimit = prune?.dailyLimit ?? 0;
  const lastRunAt = prune?.lastRunAt ?? null;

  return (
    <Card raised index={0}>
      <CardHeader icon="magnifying-glass-chart" aux={isScanning ? 'scanning…' : undefined}>
        Prune · Scan
      </CardHeader>
      <CardBody>
        <div class="t-stats">
          <Stat label="Following">{scannedEver ? <NumberTicker value={following} /> : '—'}</Stat>
          <Stat label="Followers">{scannedEver ? <NumberTicker value={followers} /> : '—'}</Stat>
          <Stat label="Not following back">
            {scannedEver ? <NumberTicker value={candidates} /> : '—'}
          </Stat>
        </div>
        <KeyValue k="Pruned today">
          <b>{commas(dailyDone)}</b> <span class="dim">/ {dailyLimit > 0 ? commas(dailyLimit) : '—'}</span>
        </KeyValue>
        <KeyValue k="Last run">{lastRunAt !== null ? relTime(lastRunAt) : 'never'}</KeyValue>
        {isScanning ? (
          <Button
            wide
            danger
            icon="stop"
            iconSpin={stopping}
            disabled={stopping}
            onClick={() => {
              void onStopScan();
            }}
          >
            Stop scan
          </Button>
        ) : (
          <Button
            wide
            icon="magnifying-glass"
            disabled={pruneRunning}
            onClick={onScan}
          >
            Scan for non-followers
          </Button>
        )}
        <div class="hint" hidden={busy || growthRunning}>
          Read-only — compares who you follow against who follows you. Nothing is unfollowed.
        </div>
        <div class="hint" hidden={!busy}>
          Walking your following and followers lists — this can take a while on large accounts.
        </div>
        <div class="hint" hidden={!growthRunning || busy}>
          The growth engine is running — scanning pauses it, then resumes it when the scan finishes.
        </div>
      </CardBody>
    </Card>
  );
}
