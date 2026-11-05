import { type JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { PruneCandidateView } from '@/ipc/contract';
import { settingsFactsSignal, settingsViewSignal, useShell, useShellControls } from '@/renderer/app/shell-context';
import { PruneCandidatesCard } from '@/renderer/cards/prune/PruneCandidatesCard';
import { PruneCensusCard } from '@/renderer/cards/prune/PruneCensusCard';
import { PruneProtectionTile } from '@/renderer/cards/prune/PruneProtectionTile';
import { PruneRunCard, stateChip } from '@/renderer/cards/prune/PruneRunCard';
import { PruneScanCard } from '@/renderer/cards/prune/PruneScanCard';
import { PRUNE_COPY, PRUNE_REFUSAL } from '@/renderer/cards/prune/prune-copy';
import { UNFOLLOW_COPY } from '@/renderer/settings/copy/choices';
import { agoLabel, fill } from '@/renderer/settings/format';
import { Badge } from '@/renderer/ui/Badge';
import { Button } from '@/renderer/ui/Button';
import type { PruneScanResult } from '@/types';

/** A refused scan or run, in plain words. */
function refusalMessage(reason: string | undefined): string {
  if (reason !== undefined && reason in PRUNE_REFUSAL) return PRUNE_REFUSAL[reason as keyof typeof PRUNE_REFUSAL];
  return reason ? `Prune refused: ${reason}` : 'Prune refused.';
}

type List = { kind: 'none' } | { kind: 'ok'; rows: readonly PruneCandidateView[] } | { kind: 'failed' };

/**
 * The Prune page (spec §7.8): the census, the scan and run, the candidates as main annotates them, and
 * what is protected (read only, edited in Settings). Pruning gradually is the Unfollowing setting, turned
 * on here with the same confirm; today's allowance is the plan's, shown read only. No settings are edited
 * on this page beyond that one opt-in.
 */
export function PruneView(): JSX.Element {
  const { status, prune, confirm, toast } = useShell();
  const { openSettings } = useShellControls();
  const view = settingsViewSignal.value;
  const facts = settingsFactsSignal.value;
  const [scan, setScan] = useState<PruneScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<'run' | 'stop' | null>(null);
  const [list, setList] = useState<List>({ kind: 'none' });
  const [reload, setReload] = useState(0);

  const growthRunning = status?.state === 'running';
  // Run is unlocked by a fresh, complete scan; `scanReady` is main's word (it expires and clears when used).
  const readyToRun = prune !== null ? prune.scanReady : scan !== null;
  const remaining = prune?.remaining ?? 0;

  // The saved census's candidates arrive annotated by protection; re-read whenever the census or the rules move.
  useEffect(() => {
    if (remaining === 0 && scan === null) {
      setList({ kind: 'none' });
      return;
    }
    let alive = true;
    window.epo.pruneCandidates().then(
      (result) => {
        if (alive) setList(result.ok ? { kind: 'ok', rows: result.candidates } : { kind: 'failed' });
      },
      () => {
        if (alive) setList({ kind: 'failed' });
      },
    );
    return () => {
      alive = false;
    };
  }, [scan, remaining, prune?.scanAt, view?.rev, reload]);

  const rows = list.kind === 'ok' ? list.rows : null;
  const open = rows === null ? null : rows.filter((r) => r.protectedBy === null);
  const tooLarge = facts?.built === true && facts.cleanup?.census?.tooLarge === true;

  const onScan = useCallback((): void => {
    setScanning(true);
    window.epo
      .scanPrune()
      .then((res) => {
        if (!res.ok) toast('error', refusalMessage(res.reason));
        else if (res.aborted === true) toast('info', 'Scan stopped — the census is incomplete.');
        else setScan(res);
      })
      .catch((e: unknown) => toast('error', `Scan failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setScanning(false));
  }, [toast]);

  const onRun = useCallback(async (): Promise<void> => {
    const n = open?.length ?? 0;
    const ok = await confirm({
      title: PRUNE_COPY.pruneNowTitle,
      body: n > 0 ? fill(PRUNE_COPY.pruneNowBody, { n }) : PRUNE_COPY.pruneNowBodyNoList,
      confirm: PRUNE_COPY.pruneNowYes,
      dismiss: PRUNE_COPY.pruneNowNo,
      danger: true,
    });
    if (!ok) return;
    setPending('run');
    try {
      const res = await window.epo.startPrune();
      if (!res.ok) toast('error', refusalMessage(res.reason));
      // The run consumes the reviewed census; the live prune status carries the truth from here.
      else setScan(null);
    } catch (e) {
      toast('error', `Prune failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending(null);
    }
  }, [confirm, toast, open]);

  const onStop = useCallback((): void => {
    setPending('stop');
    window.epo
      .stopPrune()
      .catch((e: unknown) => toast('error', `Stop failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setPending(null));
  }, [toast]);

  /** Prune gradually = the Unfollowing setting's "a few a day", asked the same way Settings asks. */
  const onGradual = async (): Promise<void> => {
    const census = facts?.built ? (facts.cleanup?.census ?? null) : null;
    const ok = await confirm({
      title: UNFOLLOW_COPY.confirmTitle,
      body: census === null ? UNFOLLOW_COPY.confirmNoCensus
        : fill(UNFOLLOW_COPY.confirm, { n: census.candidates, ago: agoLabel(census.at, Date.now()), k: census.protectedAmong }),
      confirm: UNFOLLOW_COPY.confirmYes,
      dismiss: UNFOLLOW_COPY.confirmNo,
    });
    if (!ok) return;
    window.epo.applySettings([{ op: 'intent', key: 'cleanup', value: 'trickle' }]).then(
      (r) => toast(r.kind === 'saved' ? 'success' : 'error', r.kind === 'saved' ? PRUNE_COPY.gradualSaved : PRUNE_COPY.notSaved),
      () => toast('error', PRUNE_COPY.notSaved),
    );
  };
  const gradualOn = view !== null && view.intent.cleanup !== 'off';
  const gradual = view === null ? null : gradualOn ? (
    <p class="hint">
      {PRUNE_COPY.gradualOn}{' '}
      <button type="button" class="link-btn" onClick={() => openSettings({ section: 'unfollow' })}>
        {PRUNE_COPY.gradualChange}
      </button>
    </p>
  ) : (
    <Button wide icon="user-minus" onClick={() => void onGradual()}>
      {PRUNE_COPY.gradual}
    </Button>
  );

  const chip = stateChip(prune?.state);
  return (
    <div class="prune-page stage-page">
      <header class="prune-hero">
        <div>
          <h1>{PRUNE_COPY.title}</h1>
          <p>{PRUNE_COPY.lead}</p>
        </div>
        <Badge tone={chip.tone}>{chip.label}</Badge>
      </header>
      {/* The wrapper is the intro tour's spotlight anchor for the prune step. */}
      <div class="tour-wrap" data-tour="prune-census">
        <PruneCensusCard
          prune={prune}
          scanning={scanning}
          visibleCount={open === null ? null : open.length}
          protectedCount={rows === null || open === null ? null : rows.length - open.length}
        />
      </div>
      {tooLarge ? (
        <div class="hint warn" role="status">
          {PRUNE_COPY.tooLarge}
        </div>
      ) : null}
      <div class="prune-cols">
        <div class="prune-col stage-col">
          <PruneScanCard prune={prune} scan={scan} scanning={scanning} growthRunning={growthRunning} stopping={pending === 'stop'}
            onScan={onScan} onStop={onStop} confirm={confirm} />
          <PruneRunCard prune={prune} growthRunning={growthRunning} readyToRun={readyToRun && !tooLarge} candidates={open?.length ?? 0}
            pending={pending} onRun={() => void onRun()} onStop={onStop} confirm={confirm} gradual={tooLarge ? null : gradual} />
        </div>
        <div class="prune-col stage-col">
          {tooLarge ? null : (
            <PruneCandidatesCard rows={rows} scanning={scanning} failed={list.kind === 'failed'} onRetry={() => setReload((n) => n + 1)} />
          )}
          <PruneProtectionTile />
        </div>
      </div>
    </div>
  );
}
