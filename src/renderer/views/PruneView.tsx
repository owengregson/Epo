/** @jsx h */
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { EpoStatus, PruneCandidate, PruneScanResult, Settings } from '@/types';
import { filterPruneCandidates } from '@/engine/prune-whitelist';
import type { ConfirmOptions } from '../hooks/useConfirm';
import type { ToastKind } from '../hooks/useToasts';
import { usePruneStatus } from '../hooks/usePruneStatus';
import { commas } from '../lib/format';
import { Card, CardBody } from '../ui/Card';
import { PruneScanCard } from '../cards/prune/PruneScanCard';
import { PruneRunCard } from '../cards/prune/PruneRunCard';
import { PruneCandidatesCard } from '../cards/prune/PruneCandidatesCard';
import { PruneWhitelistCard } from '../cards/prune/PruneWhitelistCard';
import { PruneScheduleCard } from '../cards/prune/PruneScheduleCard';

/** Readable message for a typed prune refusal (`ok: false` from scan/start). */
function refusalMessage(reason: string | undefined): string {
  switch (reason) {
    case 'growth-running':
      return 'Stop the growth engine before pruning.';
    case 'growth-busy':
      return 'The growth engine is finishing a step — try again in a moment.';
    case 'prune-running':
      return 'A prune scan or run is already active.';
    case 'not-logged-in':
      return 'Not logged in — open Overview and log in to Instagram first.';
    default:
      return reason ? `Prune refused: ${reason}` : 'Prune refused.';
  }
}

export interface PruneViewProps {
  /** Engine status — the run controls disable while growth owns the tab. */
  status: EpoStatus | null;
  settings: Settings | null;
  onSaved(next: Settings): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The shell's toast pusher — typed refusals and rejects surface here. */
  toast(kind: ToastKind, message: string): void;
}

/**
 * Prune view — Phase 5 auto-prune. Scan (read-only census), Run (confirm-gated
 * unfollow controls with the live meter), Candidates (who a run would drop),
 * Whitelist (never-pruned accounts), and Schedule (recurring cadence + daily
 * cap). Prune settings persist immediately as partials through
 * `settings:update`; the live projection arrives via {@link usePruneStatus}.
 */
export function PruneView({ status, settings, onSaved, confirm, toast }: PruneViewProps): h.JSX.Element {
  const prune = usePruneStatus();
  const [scan, setScan] = useState<PruneScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<'run' | 'stop' | null>(null);

  // Phase 5 hand-off: prune no longer waits for growth to be idle — pressing Scan
  // or Run pauses a RUNNING growth engine, does the prune, and resumes it after.
  // So the only thing the cards surface is an informational "this will pause
  // growth" note while growth is actively running (a user-paused engine leaves
  // the tab free already, so no pause/resume is needed there).
  const growthRunning = status?.state === 'running';

  // 2-step gate: Run is locked until a fresh, complete scan is ready. The backend
  // `scanReady` flag is authoritative (it expires and clears when consumed); the
  // session scan only bridges the first paint. Whitelist edits do NOT lock Run —
  // the candidate set re-derives live instead.
  const readyToRun = prune !== null ? prune.scanReady : scan !== null;

  // RESTORED candidates (docs/PRINCIPLES.md §2 — the UI mirrors the graph):
  // on launch, a persisted scan's not-yet-visited census populates the list
  // immediately instead of sitting empty until a fresh scan. A session scan
  // supersedes it; re-pulled whenever the backend reports a ready scan while
  // no session scan exists (e.g. a scheduled scan completed).
  const [restored, setRestored] = useState<PruneCandidate[] | null>(null);
  const remainingCount = prune?.remaining ?? 0;
  useEffect(() => {
    // The saved census populates the list whenever unvisited rows exist —
    // even when it has EXPIRED for running (Run stays gated on `scanReady`;
    // the list itself must never blank out just because time passed).
    if (scan !== null || remainingCount === 0) return;
    let alive = true;
    window.epo
      .pruneCandidates()
      .then((rows) => {
        if (alive) setRestored(rows);
      })
      .catch(() => {
        /* foundation logs; the empty state stands */
      });
    return () => {
      alive = false;
    };
  }, [scan, remainingCount]);

  // The scan census is RAW (whitelist not applied); derive the visible and
  // runnable list against the LIVE whitelist so an edit reacts instantly —
  // adding a user hides their row, removing them brings it back.
  const rawCandidates = scan?.candidates ?? (remainingCount > 0 ? restored : null);
  const visibleCandidates = useMemo(
    () =>
      rawCandidates === null
        ? null
        : filterPruneCandidates(rawCandidates, settings?.pruneWhitelist ?? []),
    [rawCandidates, settings?.pruneWhitelist],
  );

  /** Persist a prune-settings partial and relay the saved object to the shell. */
  const save = useCallback(
    (part: Partial<Settings>): void => {
      window.epo
        .updateSettings(part)
        .then(onSaved)
        .catch(() => {
          /* foundation logs; the canonical settings keep their values */
        });
    },
    [onSaved],
  );

  const onScan = useCallback((): void => {
    setScanning(true);
    window.epo
      .scanPrune()
      .then((res) => {
        if (!res.ok) {
          toast('error', refusalMessage(res.reason));
          return;
        }
        if (res.aborted === true) {
          // A stopped scan is a PARTIAL census — presenting its empty candidate
          // list would read as "everyone you follow follows you back".
          toast('info', 'Scan stopped — the census is incomplete.');
          return;
        }
        setScan(res);
      })
      .catch((e: unknown) =>
        toast('error', `Scan failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setScanning(false));
  }, [toast]);

  const knownCandidates = visibleCandidates !== null ? visibleCandidates.length : (prune?.candidates ?? 0);

  const onRun = useCallback(async (): Promise<void> => {
    const n = knownCandidates;
    const ok = await confirm({
      title: 'Run prune?',
      body:
        n > 0
          ? `Unfollow ${commas(n)} ${n === 1 ? 'account' : 'accounts'} that ${n === 1 ? 'doesn’t' : 'don’t'} follow you back? ` +
            'Whitelisted accounts are skipped and the daily limit still applies.'
          : 'Prune scans your following list, then unfollows every account that doesn’t follow you back. ' +
            'Whitelisted accounts are skipped and the daily limit still applies.',
      confirm: 'Run prune',
      dismiss: 'Keep them',
      danger: true,
    });
    if (!ok) return;
    setPending('run');
    try {
      const res = await window.epo.startPrune();
      if (!res.ok) toast('error', refusalMessage(res.reason));
      // The run consumes the reviewed census — the session's scan snapshot is
      // stale from this moment (it used to keep listing accounts already
      // unfollowed, and the next Run dialog quoted a count that no longer
      // existed). The live prune status stream carries the truth from here.
      else setScan(null);
    } catch (e) {
      toast('error', `Prune failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(null);
    }
  }, [confirm, toast, knownCandidates]);

  // Plain stop — both cards confirm-gate before calling this (scan + run stops).
  const onStop = useCallback((): void => {
    setPending('stop');
    window.epo
      .stopPrune()
      .catch((e: unknown) =>
        toast('error', `Stop failed: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => setPending(null));
  }, [toast]);

  return (
    <Fragment>
      <PruneScanCard
        prune={prune}
        scan={scan}
        scanning={scanning}
        growthRunning={growthRunning}
        stopping={pending === 'stop'}
        onScan={onScan}
        onStop={onStop}
        confirm={confirm}
      />
      <PruneRunCard
        prune={prune}
        growthRunning={growthRunning}
        readyToRun={readyToRun}
        candidates={knownCandidates}
        pending={pending}
        onRun={() => {
          void onRun();
        }}
        onStop={onStop}
        confirm={confirm}
        settings={settings}
        onSave={save}
      />
      <PruneCandidatesCard
        scanned={visibleCandidates !== null}
        candidates={visibleCandidates ?? []}
        scanning={scanning}
      />
      {settings !== null ? (
        <Fragment>
          <PruneWhitelistCard whitelist={settings.pruneWhitelist} onSave={save} />
          <PruneScheduleCard settings={settings} onSave={save} />
        </Fragment>
      ) : (
        <Card index={3}>
          <CardBody>Loading settings…</CardBody>
        </Card>
      )}
    </Fragment>
  );
}
