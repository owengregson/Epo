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
  stageCount,
  type QueueStageKey,
} from '@/renderer/cards/queues/QueuePipeline';
import { QueueRowItem } from '@/renderer/cards/queues/QueueRowItem';

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

  return (
    <Fragment>
      <QueuePipeline status={status} active={stageKey} onSelect={setStageKey} />
      <div class="qsum num">{stageSummary(stageKey, count)}</div>
      <Card index={0}>
        <CardHeader>{stage.title}</CardHeader>
        <div class="qrows">
          {/* Keyed by stage so a tab switch remounts the list and replays qfade. */}
          <div class="qlist" key={stageKey}>
            {loading ? (
              <QueueNote text="Loading…" />
            ) : rows.length === 0 ? (
              <QueueNote text="Nothing here yet." />
            ) : (
              rows.map((row) => <QueueRowItem key={row.pk} stage={stageKey} row={row} />)
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
