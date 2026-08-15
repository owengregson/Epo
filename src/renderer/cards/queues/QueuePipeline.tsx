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

/** The DOM id of the stage row-list panel the tabs control (QueuesView). */
export const QUEUE_STAGE_PANEL_ID = 'queue-stage-list';

/**
 * The connected stage selector — the actual flow of an account through the
 * churn lifecycle. Four `.qstage` tabs joined by `.qflow` chevrons, faithful
 * to the mockup's `.qpipe` markup; counts are bound to the live status.
 * Keyboard: the tabs pattern (roving tabindex + arrow keys), mirroring
 * `Segmented`, so both selectors behave identically for keyboard users.
 */
export function QueuePipeline({ status, active, onSelect }: QueuePipelineProps): h.JSX.Element {
  const idx = Math.max(
    0,
    QUEUE_STAGES.findIndex((s) => s.key === active),
  );

  const onKeyDown = (e: KeyboardEvent): void => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    const nx = (idx + dir + QUEUE_STAGES.length) % QUEUE_STAGES.length;
    onSelect(QUEUE_STAGES[nx].key);
    const group = e.currentTarget as HTMLElement;
    const btn = group.querySelectorAll('button')[nx] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div class="qpipe num" role="tablist" aria-label="Lifecycle pipeline" onKeyDown={onKeyDown}>
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
            aria-controls={QUEUE_STAGE_PANEL_ID}
            tabIndex={stage.key === active ? 0 : -1}
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
