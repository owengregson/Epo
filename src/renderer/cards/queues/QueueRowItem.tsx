/** @jsx h */
import { h } from 'preact';
import type { QueueRow } from '@/types';
import { Icon } from '@/renderer/ui/Icon';
import { clamp, monogram, pctInt, ratio, withAt } from '@/renderer/lib/format';
import type { QueueStageKey } from './QueuePipeline';

const DAY_MS = 24 * 3600 * 1000;

/** Fallback follow-back window while settings load (`maxWaitForFollowbackDays` = 4). */
const FOLLOWBACK_WINDOW_MS = 4 * DAY_MS;

/** Fallback post-followback hold while settings load (`holdAfterFollowbackDays` = 2). */
const HOLD_MS = 2 * DAY_MS;

/** The live settings-derived windows, passed down from the view (null while loading). */
export interface QueueWindows {
  followbackMs: number;
  holdMs: number;
}

/** Stage-specific context line + progress-bar fill, derived from real timestamps. */
interface RowContext {
  ctx: string;
  /** Bar fill fraction 0..1, or null to omit the bar entirely. */
  barFrac: number | null;
  /** Brass (warn-toned) bar — only the Due stage. */
  brass: boolean;
}

/**
 * Derive the honest, stage-specific context for a row. Everything here comes
 * from the record's own timestamps vs `now` — no invented scores or averages.
 */
function deriveContext(
  stage: QueueStageKey,
  row: QueueRow,
  now: number,
  windows: QueueWindows | null,
): RowContext {
  const followbackWindowMs = windows?.followbackMs ?? FOLLOWBACK_WINDOW_MS;
  const holdMs = windows?.holdMs ?? HOLD_MS;
  switch (stage) {
    case 'queued':
      // Ranked candidate, not yet followed — nothing time-based to show.
      return { ctx: 'candidate', barFrac: null, brass: false };

    case 'awaiting': {
      if (row.followedAt === undefined) {
        return { ctx: 'awaiting follow-back', barFrac: null, brass: false };
      }
      const elapsed = Math.max(0, now - row.followedAt);
      const days = Math.floor(elapsed / DAY_MS);
      return {
        ctx: days <= 0 ? 'followed today' : `followed ${days}d ago`,
        barFrac: clamp(elapsed / followbackWindowMs, 0, 1),
        brass: false,
      };
    }

    case 'held': {
      if (row.holdUntil === undefined) {
        return { ctx: 'followed back · holding', barFrac: null, brass: false };
      }
      const remaining = row.holdUntil - now;
      if (remaining <= 0) {
        return { ctx: 'hold complete', barFrac: 1, brass: false };
      }
      const days = Math.ceil(remaining / DAY_MS);
      return {
        ctx: `hold ends in ${days}d`,
        barFrac: clamp(1 - remaining / holdMs, 0, 1),
        brass: false,
      };
    }

    case 'due':
      return { ctx: 'hold complete · ready', barFrac: 1, brass: true };
  }
}

export interface QueueRowItemProps {
  /** Which lifecycle stage this row is listed under (drives ctx + bar). */
  stage: QueueStageKey;
  /** The joined follow_record/account row from `queue:list`. */
  row: QueueRow;
  /** Live settings-derived windows so bars track the USER's configured days. */
  windows: QueueWindows | null;
}

/**
 * One `.qr` lifecycle row: monogram avatar, handle with private/ready chips,
 * a stage-specific context line with a progress bar derived from the record's
 * real timestamps, and the follower-ratio chip. The only inline style is the
 * mockup-sanctioned `.qbar i` fill width.
 */
export function QueueRowItem({ stage, row, windows }: QueueRowItemProps): h.JSX.Element {
  const due = stage === 'due';
  const { ctx, barFrac, brass } = deriveContext(stage, row, Date.now(), windows);
  const handle = withAt(row.username) || row.pk;

  return (
    <div class={due ? 'qr due' : 'qr'}>
      <span class="qr-av num">{monogram(row.username)}</span>
      <div class="qr-main">
        <div class="qr-top">
          <span class="handle">{handle}</span>
          {row.isPrivate ? (
            <span class="priv">
              <Icon name="lock" title="Private" />
              Private
            </span>
          ) : null}
          {due ? <span class="ready">Ready</span> : null}
        </div>
        <div class="qr-sub num">
          <span class="ctx">{ctx}</span>
          {barFrac !== null ? (
            <span class={brass ? 'qbar brass' : 'qbar'}>
              <i style={`width:${pctInt(barFrac)}%`} />
            </span>
          ) : null}
        </div>
      </div>
      <span class="rchip num">r={ratio(row.ratio ?? 0)}</span>
    </div>
  );
}
