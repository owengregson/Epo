import { type JSX } from 'preact';
import type { RowLaneKey } from '@/renderer/cards/queues/lanes';
import { clamp, monogram, pctInt, withAt } from '@/renderer/lib/format';
import { Icon } from '@/renderer/ui/Icon';
import type { KeptRow } from '@/shared/settings-facts';
import type { EffectiveSummary } from '@/shared/settings-view';
import type { QueueRow } from '@/types';

/** A day, as a unit of the row's own timestamps (a grid, not a timing). */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The follow-back wait and the hold after a follow-back, from the live settings (null while loading). */
export interface QueueWindows {
  followbackMs: number;
  holdMs: number | null;
}

/** The windows from the settings the shell loaded; null before they land (rows then show no bar). */
export function queueWindowsOf(
  s: Pick<EffectiveSummary, 'waitDays' | 'holdDays'> | null,
): QueueWindows | null {
  return s === null ? null : { followbackMs: s.waitDays * DAY_MS, holdMs: s.holdDays === null ? null : s.holdDays * DAY_MS };
}

/** A row's line and its progress bar, from the record's own timestamps. */
interface RowContext {
  ctx: string;
  /** Bar fill 0..1, or null to omit the bar (no window known yet, or none applies). */
  barFrac: number | null;
  /** Warm bar — only for people leaving soon. */
  brass: boolean;
}

const days = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The honest, lane-specific line for a row: everything from its own timestamps against `now`. */
export function rowContext(lane: RowLaneKey, row: QueueRow, now: number, windows: QueueWindows | null): RowContext {
  switch (lane) {
    case 'next': {
      const m = row.mutuals;
      return { ctx: m != null && m > 0 ? `Good fit · ${m} followers in common` : 'Good fit', barFrac: null, brass: false };
    }
    case 'waiting': {
      if (row.followedAt === undefined) return { ctx: 'Waiting for a follow-back', barFrac: null, brass: false };
      const elapsed = Math.max(0, now - row.followedAt);
      const d = Math.floor(elapsed / DAY_MS);
      const ctx = d <= 0 ? 'Followed today' : d === 1 ? 'Followed yesterday' : `Followed ${d} days ago`;
      return { ctx, barFrac: windows === null ? null : clamp(elapsed / windows.followbackMs, 0, 1), brass: false };
    }
    case 'back': {
      if (windows?.holdMs === null) return { ctx: 'Followed you back · kept', barFrac: null, brass: false };
      if (row.holdUntil === undefined) return { ctx: 'Followed you back', barFrac: null, brass: false };
      const remaining = row.holdUntil - now;
      if (remaining <= 0) return { ctx: 'Followed you back · ready to unfollow', barFrac: 1, brass: false };
      return {
        ctx: `Followed you back · unfollow in ${days(Math.ceil(remaining / DAY_MS))}`,
        barFrac: windows === null ? null : clamp(1 - remaining / windows.holdMs, 0, 1),
        brass: false,
      };
    }
    case 'leaving':
      return { ctx: 'Leaving in an upcoming session', barFrac: 1, brass: true };
  }
}

export interface QueueRowItemProps {
  lane: RowLaneKey;
  /** The joined follow_record/account row from `queue:list`. */
  row: QueueRow;
  windows: QueueWindows | null;
}

/** One person in a lane: monogram, handle (and Private), the lane's line and its progress bar. */
export function QueueRowItem({ lane, row, windows }: QueueRowItemProps): JSX.Element {
  const leaving = lane === 'leaving';
  const { ctx, barFrac, brass } = rowContext(lane, row, Date.now(), windows);

  return (
    <div class={leaving ? 'qr due' : 'qr'}>
      <span class="qr-av num">{monogram(row.username)}</span>
      <div class="qr-main">
        <div class="qr-top">
          <span class="handle">{withAt(row.username) || row.pk}</span>
          {row.isPrivate ? (
            <span class="priv">
              <Icon name="lock" title="Private" />
              Private
            </span>
          ) : null}
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
    </div>
  );
}

/** Why protection keeps someone, in words (spec §7.5); an unknown reason still reads as kept. */
export function keptWhy(row: Pick<KeptRow, 'reason' | 'match'>): string {
  switch (row.reason) {
    case 'account':
      return 'Kept · on your protection list';
    case 'verified':
      return 'Kept · verified account';
    case 'bio-word':
      return row.match !== null ? `Kept · bio mentions “${row.match}”` : 'Kept · a protected word in the bio';
    case 'source':
      return 'Kept · Epo explores through this account';
    case 'unreadable-bio':
    case 'unreadable-verified':
      return 'Kept until Epo can read the profile · checked again later';
    default:
      return 'Kept · protected';
  }
}

/** One person protection keeps (the Kept lane). */
export function KeptRowItem({ row }: { row: KeptRow }): JSX.Element {
  return (
    <div class="qr">
      <span class="qr-av num">{monogram(row.username)}</span>
      <div class="qr-main">
        <div class="qr-top">
          <span class="handle">{withAt(row.username) || row.pk}</span>
        </div>
        <div class="qr-sub">
          <span class="ctx">{keptWhy(row)}</span>
        </div>
      </div>
    </div>
  );
}
