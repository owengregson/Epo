/** @jsx h */
import { h, Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { EpoStatus } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { useQueue } from '@/renderer/hooks/useQueue';
import { commas } from '@/renderer/lib/format';
import {
  QueuePipeline,
  QUEUE_STAGE_BY_KEY,
  QUEUE_STAGE_PANEL_ID,
  stageCount,
  type QueueStageKey,
} from '@/renderer/cards/queues/QueuePipeline';
import { QueueRowItem, type QueueWindows } from '@/renderer/cards/queues/QueueRowItem';
import { useSettings } from '@/renderer/hooks/useSettings';
import { MS_PER_DAY } from '@/timing/units';

export interface QueuesViewProps {
  status: EpoStatus | null;
}

/** The `.qsum` line for the active stage — derived only from the live count. */
function stageSummary(key: QueueStageKey, count: number): h.JSX.Element {
  const n = commas(count);
  switch (key) {
    case 'queued':
      return (
        <b>
          {n} ranked {count === 1 ? 'candidate' : 'candidates'}
        </b>
      );
    case 'awaiting':
      return <b>{n} awaiting follow-back</b>;
    case 'held':
      return <b>{n} followed back</b>;
    case 'due':
      return (
        <Fragment>
          <b>{n} cleared hold</b> · unfollow in next slots
        </Fragment>
      );
  }
}

/** A muted, row-aligned message line (loading / empty / truncation notes). */
function QueueNote({ text }: { text: string }): h.JSX.Element {
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

/**
 * Queues view — the lifecycle pipeline. A connected `.qpipe` stage selector
 * (Queued → Awaiting → Held → Due) bound to the live status counts, a derived
 * `.qsum` line, and one card listing the active stage's rows from `queue:list`.
 */
export function QueuesView(props: QueuesViewProps): h.JSX.Element {
  const { status } = props;
  const [stageKey, setStageKey] = useState<QueueStageKey>('queued');
  const stage = QUEUE_STAGE_BY_KEY[stageKey];
  const count = stageCount(stageKey, status);
  const { rows, truncated, loading } = useQueue(stage.state, status);
  // Live settings so the row progress bars track the USER's configured windows
  // instead of hardcoded design defaults (which silently desync on edit).
  const settings = useSettings();
  const windows: QueueWindows | null = settings
    ? {
        followbackMs: settings.maxWaitForFollowbackDays * MS_PER_DAY,
        holdMs: settings.holdAfterFollowbackDays * MS_PER_DAY,
      }
    : null;

  return (
    <Fragment>
      <QueuePipeline status={status} active={stageKey} onSelect={setStageKey} />
      <div class="qsum num">{stageSummary(stageKey, count)}</div>
      <Card index={0}>
        <CardHeader>{stage.title}</CardHeader>
        <div class="qrows">
          {/* Keyed by stage so a tab switch remounts the list and replays qfade.
              The id is the pipeline tabs' aria-controls target. */}
          <div class="qlist" id={QUEUE_STAGE_PANEL_ID} role="tabpanel" key={stageKey}>
            {loading ? (
              <QueueNote text="Loading…" />
            ) : rows.length === 0 ? (
              <QueueNote text="Nothing here yet." />
            ) : (
              rows.map((row) => (
                <QueueRowItem key={row.pk} stage={stageKey} row={row} windows={windows} />
              ))
            )}
            {!loading && truncated ? (
              <QueueNote text={`Showing the first ${rows.length} — more queued.`} />
            ) : null}
          </div>
        </div>
      </Card>
    </Fragment>
  );
}
