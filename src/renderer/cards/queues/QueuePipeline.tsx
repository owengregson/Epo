import { Fragment, type JSX } from 'preact';
import { LANES, type LaneKey } from '@/renderer/cards/queues/lanes';
import { commas } from '@/renderer/lib/format';
import { Icon } from '@/renderer/ui/Icon';
import type { EpoStatus } from '@/types';

/** Each lane's count; null where it is not known yet (shown as "—", never as 0). */
export type LaneCounts = Readonly<Record<LaneKey, number | null>>;

/** The lane counts straight off the status projection, plus the kept table's total. */
export function laneCounts(status: EpoStatus | null, kept: number | null): LaneCounts {
  const known = status !== null && status.basis === 'built';
  return {
    next: known ? status.queued : null,
    waiting: known ? status.pendingFollowback : null,
    back: known ? status.followedBackHeld : null,
    leaving: known ? status.unfollowDue : null,
    kept,
  };
}

export interface QueuePipelineProps {
  counts: LaneCounts;
  /** The lane shown below. */
  active: LaneKey;
  onSelect: (key: LaneKey) => void;
}

/** The DOM id of the lane's row list the tabs control. */
export const QUEUE_STAGE_PANEL_ID = 'queue-stage-list';

/**
 * The "In progress" lanes as one connected selector — the path a person takes
 * through Epo: Up next → Waiting → Following back → Leaving soon, and Kept for
 * the people protection keeps. Counts move with the live status. Keyboard: the
 * tabs pattern (roving tabindex + arrow keys), like every selector here.
 */
export function QueuePipeline({ counts, active, onSelect }: QueuePipelineProps): JSX.Element {
  const idx = Math.max(
    0,
    LANES.findIndex((l) => l.key === active),
  );

  const onKeyDown = (e: KeyboardEvent): void => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const nx = (idx + dir + LANES.length) % LANES.length;
    const lane = LANES[nx];
    if (lane === undefined) return;
    onSelect(lane.key);
    const btn = (e.currentTarget as HTMLElement).querySelectorAll('button')[nx] as HTMLButtonElement | undefined;
    btn?.focus();
  };

  return (
    <div class="qpipe num" role="tablist" aria-label="In progress" onKeyDown={onKeyDown}>
      {LANES.map((lane, i) => {
        const n = counts[lane.key];
        return (
          <Fragment key={lane.key}>
            {i > 0 ? (
              <span class="qflow" aria-hidden="true">
                <Icon name={lane.key === 'kept' ? 'shield-halved' : 'chevron-right'} />
              </span>
            ) : null}
            <button
              type="button"
              class={lane.key === active ? 'qstage active' : 'qstage'}
              role="tab"
              aria-selected={lane.key === active ? 'true' : 'false'}
              aria-controls={QUEUE_STAGE_PANEL_ID}
              tabIndex={lane.key === active ? 0 : -1}
              data-lane={lane.key}
              onClick={() => onSelect(lane.key)}
            >
              <span class="n">{n === null ? '—' : commas(n)}</span>
              <span class="l">{lane.label}</span>
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
