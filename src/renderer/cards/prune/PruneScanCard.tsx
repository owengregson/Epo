/** @jsx h */
import { Fragment, h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { useCountUp } from '@/renderer/hooks/useCountUp';
import { commas, relTime } from '@/renderer/lib/format';
import { Button } from '@/renderer/ui/Button';
import { Card, CardBody, CardHeader } from '@/renderer/ui/Card';
import { KeyValue } from '@/renderer/ui/KeyValue';
import { Meter } from '@/renderer/ui/Meter';
import type { PruneScanResult, PruneStatus } from '@/types';

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
 * Prune · Scan — the read-only census walk. One button walks the full
 * following + followers lists (the numbers themselves live on the census
 * card), with a continuous progress bar across both phases, today's
 * prune-ledger spend, and when the last scan/run completed. While a scan is
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

  // Smooth count-ups: mid-scan pushes land in page-sized jumps; while a scan is
  // LIVE the chase is PACED — linear motion sized to the push cadence, so the
  // bar riding these climbs continuously between pages instead of sprinting
  // and idling. Off-scan (including the completion settle) it reverts to the
  // quick ease-out. Snaps on reset either way. (The census tiles themselves
  // live on PruneCensusCard, which runs the same live math.)
  const followingDisplay = useCountUp(following, { paced: isScanning });
  const followersDisplay = useCountUp(followers, { paced: isScanning });

  // Live scan progress: the completion flash fires only when the scan
  // genuinely finishes (a stopped scan never flashes complete).
  const scanPhase = isScanning ? (prune?.scanPhase ?? null) : null;
  const [finishedFlash, setFinishedFlash] = useState(false);
  const wasScanningRef = useRef(false);
  const scanReadyRef = useRef(false);
  scanReadyRef.current = prune?.scanReady ?? false;
  useEffect(() => {
    const was = wasScanningRef.current;
    wasScanningRef.current = isScanning;
    if (was && !isScanning && scanReadyRef.current) {
      setFinishedFlash(true);
      const t = setTimeout(() => setFinishedFlash(false), 1_600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isScanning]);

  // ONE continuous bar across BOTH phases: progress is the combined walked
  // count over the combined header estimate, so the following→followers
  // hand-off never resets the fill — it keeps climbing through the midpoint.
  // Capped at 99% while scanning (header counts overshoot the real lists —
  // ghosts); a finished following phase contributes its full segment.
  const estimates = isScanning ? (prune?.scanEstimates ?? null) : null;
  const estFollowing = estimates?.following ?? null;
  const estFollowers = estimates?.followers ?? null;
  const totalEstimate =
    estFollowing !== null && estFollowers !== null && estFollowing > 0 && estFollowers > 0
      ? estFollowing + estFollowers
      : null;
  const walked =
    scanPhase === 'followers'
      ? (estFollowing ?? 0) + Math.min(followersDisplay, estFollowers ?? followersDisplay)
      : Math.min(followingDisplay, estFollowing ?? followingDisplay);
  const scanPct = totalEstimate !== null ? Math.min(99, (walked / totalEstimate) * 100) : null;
  const scanningBar = scanPhase !== null && scanPct !== null;
  const flashBar = finishedFlash && scanPhase === null;
  const showBar = scanningBar || flashBar;

  // Completion is NOT a snap to 100: the flash re-bases the percentage on the
  // settled totals, so the bar rides the same count-ups that roll the odometers
  // home to exactly 100%. The target ref holds its last value across the
  // one-render gap before the flash effect fires (and while the closed bar
  // slides out) — a hold, never a dip to 0 — and the extra useCountUp pass
  // eases whatever step the estimate→actual re-base introduces (an estimate
  // inflated by ghosts leaves a gap the ride alone can't cover).
  const settledTotal = following + followers;
  const flashPct =
    settledTotal > 0
      ? Math.min(100, ((followingDisplay + followersDisplay) / settledTotal) * 100)
      : 100;
  const barTargetRef = useRef(0);
  if (scanningBar) barTargetRef.current = scanPct;
  else if (flashBar) barTargetRef.current = flashPct;
  const barPct = useCountUp(barTargetRef.current, { durationMs: 450, round: false });

  const barLabel = flashBar
    ? 'Scan complete'
    : scanPhase === 'followers'
      ? 'Scanning followers'
      : 'Scanning following';

  // The bar block stays MOUNTED and slides open/closed (`.reveal`), so its
  // content while closing must be the last thing shown — freeze it in a ref
  // rather than letting the idle-state recompute flash "Scanning following 0%".
  const liveBar = {
    label: barLabel,
    estimate: flashBar ? null : totalEstimate,
  };
  const lastBarRef = useRef(liveBar);
  if (showBar) lastBarRef.current = liveBar;
  const barView = showBar ? liveBar : lastBarRef.current;
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
    <Card index={1}>
      <CardHeader icon="magnifying-glass-chart" aux={isScanning ? 'scanning…' : undefined}>
        Prune · Scan
      </CardHeader>
      <CardBody>
        <div class={showBar ? 'reveal open' : 'reveal'}>
          <div class="reveal-i">
            <div class="kv-block">
              <div class="top">
                <span class="k">
                  {barView.label}
                  {barView.estimate !== null ? (
                    <span class="dim2"> · of ~{commas(barView.estimate)}</span>
                  ) : null}
                </span>
                <span class="v num">{Math.round(barPct)}%</span>
              </div>
              <Meter pct={barPct} live />
            </div>
          </div>
        </div>
        <KeyValue k="Pruned today">
          <b>{commas(dailyDone)}</b> <span class="dim">/ {dailyLimit > 0 ? commas(dailyLimit) : '—'}</span>
        </KeyValue>
        <KeyValue k="Last scan">
          {prune?.scanAt != null ? (
            <Fragment>
              {relTime(prune.scanAt)}
              {!isScanning && prune.scanReady === false ? (
                <span class="dim"> · expired — scan again to run</span>
              ) : null}
            </Fragment>
          ) : (
            'none saved'
          )}
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
