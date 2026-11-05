import { Fragment, type JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type LaneRows, queueLanesSignal } from '@/renderer/app/live-signals';
import { settingsFactsSignal, settingsViewSignal, statusSignal } from '@/renderer/app/shell-context';
import { LANE_STATE, LANES, type LaneKey, type RowLaneKey } from '@/renderer/cards/queues/lanes';
import { laneCounts, QUEUE_STAGE_PANEL_ID, QueuePipeline } from '@/renderer/cards/queues/QueuePipeline';
import { KeptRowItem, QueueRowItem, queueWindowsOf } from '@/renderer/cards/queues/QueueRowItem';
import { useQueue } from '@/renderer/hooks/useQueue';
import { Skeleton } from '@/renderer/ui/Skeleton';
import type { KeptPageResult } from '@/shared/settings-facts';

/** A muted, row-aligned line (loading, empty and cut-off notes). */
function Note({ text }: { text: string }): JSX.Element {
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

/** Main logs a failing read and answers its fallback; a rejected invoke keeps the last good page. */
const keepLast = (): void => undefined;

/** The kept table's first page: preloaded by the shell, re-read on opening and when the kept count moves. */
function useKeptPage(active: boolean, preloaded: KeptPageResult | null): KeptPageResult | null {
  const [page, setPage] = useState<KeptPageResult | null>(preloaded);
  const total = settingsFactsSignal.value?.protection?.kept.total ?? null;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    window.epo.keptList(0).then((r) => {
      if (alive) setPage(r);
    }, keepLast);
    return () => {
      alive = false;
    };
  }, [active, total]);
  return page;
}

function RowLane({ lane, active, preloaded }: { lane: RowLaneKey; active: boolean; preloaded: LaneRows | null }): JSX.Element {
  const { rows, truncated, loading } = useQueue(LANE_STATE[lane], statusSignal.value, active, preloaded);
  const windows = queueWindowsOf(settingsViewSignal.value?.effective ?? null);
  if (rows.length === 0) return <Note text={loading ? 'Loading…' : 'No one here right now.'} />;
  return (
    <Fragment>
      {rows.map((row) => (
        <QueueRowItem key={row.pk} lane={lane} row={row} windows={windows} />
      ))}
      {!loading && truncated ? <Note text={`Showing the first ${rows.length}.`} /> : null}
    </Fragment>
  );
}

function KeptLane({ page }: { page: KeptPageResult | null }): JSX.Element {
  if (page === null) return <Skeleton lines={3} label="Loading the people protection keeps" />;
  if (page.kind === 'unavailable') return <Note text="Epo can’t list the people it keeps right now." />;
  if (page.rows.length === 0) return <Note text="No one is kept yet." />;
  return (
    <Fragment>
      {page.rows.map((row) => (
        <KeptRowItem key={row.pk} row={row} />
      ))}
      {page.total > page.rows.length ? <Note text={`Showing ${page.rows.length} of ${page.total}.`} /> : null}
    </Fragment>
  );
}

/**
 * "In progress" (spec §12.5): the lanes a person moves through — Up next ·
 * Waiting · Following back · Leaving soon — and Kept, for everyone protection
 * keeps. Each lane opens on the rows the shell fetched before the reveal and is
 * re-read only while the page is shown.
 */
export function ProgressPanel({ active }: { active: boolean }): JSX.Element {
  const [lane, setLane] = useState<LaneKey>('next');
  const lanes = queueLanesSignal.value;
  const kept = useKeptPage(active, lanes?.kept ?? null);
  const counts = laneCounts(statusSignal.value, kept?.kind === 'ok' ? kept.total : null);
  const hint = LANES.find((l) => l.key === lane)?.hint ?? '';
  // Until the following check (step G) accounts for them, outside changes stay marked (spec Appendix E.2).
  const unverified = (statusSignal.value?.own?.followingUnverified ?? 0) !== 0;

  return (
    <Fragment>
      <QueuePipeline counts={counts} active={lane} onSelect={setLane} />
      <p class="people-lanes__hint">{hint}</p>
      {unverified ? <p class="people-lanes__hint">Changed outside Epo · not yet verified</p> : null}
      <div class="qrows">
        <div class="qlist" id={QUEUE_STAGE_PANEL_ID} role="tabpanel" key={lane}>
          {lane === 'kept' ? (
            <KeptLane page={kept} />
          ) : (
            <RowLane lane={lane} active={active} preloaded={lanes?.[lane] ?? null} />
          )}
        </div>
      </div>
    </Fragment>
  );
}
