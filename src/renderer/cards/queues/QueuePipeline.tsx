/** @jsx h */
import { h, Fragment } from 'preact';
import type { FollowState, EpoStatus } from '@/types';
import { Icon } from '@/renderer/ui/Icon';
import { commas } from '@/renderer/lib/format';

/** UI key for one lifecycle stage tab. */
export type QueueStageKey = 'queued' | 'awaiting' | 'held' | 'due';

/** One stage of the lifecycle pipeline: UI labels + the store state it lists. */
export interface QueueStage {
  key: QueueStageKey;
  /** The `follow_records.state` literal this stage lists via `queue:list`. */
  state: FollowState;
  /** Short tab label (uppercase via CSS). */
  label: string;
  /** Card header title for the stage's row list. */
  title: string;
}

/** The four visible lifecycle stages, in pipeline order (§ queues view). */
export const QUEUE_STAGE_BY_KEY: Record<QueueStageKey, QueueStage> = {
  queued: {
    key: 'queued',
    state: 'queued',
    label: 'Queued',
    title: 'Queued · next to follow',
  },
  awaiting: {
    key: 'awaiting',
    state: 'pending_followback',
    label: 'Awaiting',
    title: 'Awaiting · follow-back window',
  },
  held: {
    key: 'held',
    state: 'followed_back',
    label: 'Held',
    title: 'Held · followed back, holding',
  },
  due: {
    key: 'due',
    state: 'unfollow_queued',
    label: 'Due',
    title: 'Due · ready to unfollow',
  },
};

export const QUEUE_STAGES: readonly QueueStage[] = [
  QUEUE_STAGE_BY_KEY.queued,
  QUEUE_STAGE_BY_KEY.awaiting,
  QUEUE_STAGE_BY_KEY.held,
  QUEUE_STAGE_BY_KEY.due,
];

/** The live count for a stage, straight off the engine status projection. */
export function stageCount(key: QueueStageKey, status: EpoStatus | null): number {
  if (!status) return 0;
  switch (key) {
    case 'queued':
      return status.queued;
    case 'awaiting':
      return status.pendingFollowback;
    case 'held':
      return status.followedBackHeld;
    case 'due':
      return status.unfollowDue;
  }
}

export interface QueuePipelineProps {
  /** Live engine status (stage counts); null before the first snapshot. */
  status: EpoStatus | null;
  /** The currently selected stage tab. */
  active: QueueStageKey;
  /** Invoked with the stage key when a tab is clicked. */
  onSelect: (key: QueueStageKey) => void;
}

/**
 * The connected stage selector — the actual flow of an account through the
 * churn lifecycle. Four `.qstage` tabs joined by `.qflow` chevrons, faithful
 * to the mockup's `.qpipe` markup; counts are bound to the live status.
 */
export function QueuePipeline({ status, active, onSelect }: QueuePipelineProps): h.JSX.Element {
  return (
    <div class="qpipe num" role="tablist" aria-label="Lifecycle pipeline">
      {QUEUE_STAGES.map((stage, i) => (
        <Fragment key={stage.key}>
          {i > 0 ? (
            <span class="qflow" aria-hidden="true">
              <Icon name="chevron-right" />
            </span>
          ) : null}
          <button
            type="button"
            class={stage.key === active ? 'qstage active' : 'qstage'}
            role="tab"
            aria-selected={stage.key === active ? 'true' : 'false'}
            data-q={stage.key}
            onClick={() => onSelect(stage.key)}
          >
            <span class="n">{commas(stageCount(stage.key, status))}</span>
            <span class="l">{stage.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}
