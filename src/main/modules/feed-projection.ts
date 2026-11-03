/**
 * The live feed (spec §12.9, Appendix C.3): what Epo did and saw, merged newest first and grouped, shaped in main
 * from the store's feed reads and a context the live wiring assembles. Pure: `now` and the plan-day clock arrive in
 * the context. No session rows: the plan holds planned times, not actual starts, so that moment would be invented.
 */

import { LIVE } from '@/kernel/live-policy';
import type { PlanDayClock } from '@/kernel/plan';
import { notBuiltFeed } from '@/main/modules/not-built';
import type { AwaySummaryLite, FeedDay, FeedItem, FeedView, Person, UnfollowWhy } from '@/shared/feed';
import type { EdgeFeedRow, EffectFeedRow, FollowBackFeedRow, LostFollowersRow } from '@/store/repos/feed-reads';

export { notBuiltFeed };

/** The store's feed reads (`KnowledgeStore.feed`). */
export interface FeedReads {
  settledEffects(since: number, limit: number): readonly EffectFeedRow[];
  followBacks(since: number, limit: number): readonly FollowBackFeedRow[];
  newFollowers(ownPk: string, since: number, limit: number): readonly EdgeFeedRow[];
  lostFollowerCount(ownPk: string, since: number): readonly LostFollowersRow[];
}

/** A Boost window as the plan core keeps it. */
export interface BoostWindowLite {
  readonly startedAt: number;
  readonly endsAt: number;
  readonly endedAt: number | null;
  readonly endReason: 'user' | 'expired' | 'clock' | null;
}

/** A review that kept an account from an unfollow. */
export interface KeptFeedRow {
  readonly pk: string;
  readonly username: string | null;
  readonly reason: string;
  readonly keptAt: number;
}

export interface FeedContext {
  readonly now: number;
  readonly ownPk: string;
  /** The followers baseline: an account first seen at or before it is stock, never news; null before measuring. */
  readonly baselineAt: number | null;
  /** The plan-day boundary the window and the day groups align to. */
  readonly planDay: Pick<PlanDayClock, 'window'>;
  /** Runtime incidents; a crash resume reads as `resumed`. */
  readonly incidents: readonly { readonly at: number; readonly reason: string }[];
  /** The recovery ladder's open or last episode. */
  readonly recoveryIncident: { readonly at: number; readonly resumeAt: number | null } | null;
  /** Where the "Since you left" divider sits. */
  readonly awayFrom: number | null;
  /** Optional ports, absent until their streams land: the Boost window, the catch-up summary, kept reviews. */
  readonly boost?: BoostWindowLite | null;
  readonly away?: AwaySummaryLite | null;
  readonly kept?: readonly KeptFeedRow[];
}

/** The runtime incident a crash resume records (the startup sequence's resume-run step). */
export const RESUMED_INCIDENT = 'process-recovery-start';

/** Rows read per source: one full group for every row the feed can show. */
const READ_ROWS = LIVE.FEED_LIMIT * LIVE.GROUP_PEOPLE_MAX;

const personOf = (r: { readonly pk: string; readonly username: string | null }): Person => ({ pk: r.pk, username: r.username });

function unfollowWhy(row: EffectFeedRow): UnfollowWhy {
  if (row.channel === 'manual') return 'you';
  if (row.channel === 'prune') return 'clean-up';
  if (row.unfollowReason === 'no-followback') return 'no-follow-back';
  return row.unfollowReason === 'hold-expired' ? 'after-follow-back' : 'other';
}

/** One settled write as its row; null for a practised accept, which Instagram never saw. */
function effectItem(row: EffectFeedRow, boost: BoostWindowLite | null | undefined): FeedItem | null {
  const at = { id: `effect:${row.id}`, at: row.settledAt };
  const person = personOf(row);
  if (row.result === 'fail' || row.result === 'expired') {
    return { ...at, kind: 'not-done', action: row.action, person, why: row.result === 'fail' ? 'error' : 'unconfirmed' };
  }
  const practice = row.result === 'simulated';
  if (row.action === 'accept') return practice ? null : { ...at, kind: 'request-accepted', people: [person] };
  if (row.action === 'unfollow') return { ...at, kind: 'unfollowed', people: [person], why: unfollowWhy(row), practice };
  const boosted = boost != null && row.settledAt >= boost.startedAt && row.settledAt < (boost.endedAt ?? boost.endsAt);
  const via = row.channel === 'manual' ? 'you' : boosted ? 'boost' : 'plan';
  return { ...at, kind: 'followed', people: [person], via, practice };
}

/** The moments that come from the context rather than the store's rows. */
function momentItems(ctx: FeedContext): FeedItem[] {
  const items: FeedItem[] = [];
  for (const i of ctx.incidents) {
    if (i.reason === RESUMED_INCIDENT) items.push({ id: `resumed:${i.at}`, at: i.at, kind: 'resumed', after: 'restart' });
  }
  const r = ctx.recoveryIncident;
  if (r !== null) items.push({ id: `slowed:${r.at}`, at: r.at, kind: 'slowed-down', until: r.resumeAt });
  const b = ctx.boost;
  if (b != null) {
    items.push({ id: `boost:${b.startedAt}:started`, at: b.startedAt, kind: 'boost', edge: 'started', endsAt: b.endsAt, why: null });
    if (b.endedAt !== null) {
      items.push({ id: `boost:${b.startedAt}:ended`, at: b.endedAt, kind: 'boost', edge: 'ended', endsAt: null, why: b.endReason });
    }
  }
  const away = ctx.away;
  if (away != null) items.push({ id: `caught-up:${away.checkedAt}`, at: away.checkedAt, kind: 'caught-up', summary: away });
  for (const k of ctx.kept ?? []) {
    items.push({ id: `kept:${k.pk}:${k.keptAt}`, at: k.keptAt, kind: 'kept', person: personOf(k), reason: k.reason });
  }
  return items;
}

/**
 * Every ungrouped row inside the window. A source that filled its read cuts every older row from every source,
 * so a gap in one never reads as a quiet stretch in the merged feed.
 */
function readItems(reads: FeedReads, ctx: FeedContext, windowStart: number): FeedItem[] {
  const cuts: number[] = [];
  const read = <T>(rows: readonly T[], at: (row: T) => number): readonly T[] => {
    if (rows.length >= READ_ROWS) cuts.push(Math.min(...rows.map(at)));
    return rows;
  };
  const effects = read(reads.settledEffects(windowStart, READ_ROWS), (r) => r.settledAt);
  const backs = read(reads.followBacks(windowStart, READ_ROWS), (r) => r.at);
  const since = ctx.baselineAt === null ? null : Math.max(windowStart, ctx.baselineAt + 1);
  const fresh = since === null ? [] : read(reads.newFollowers(ctx.ownPk, since, READ_ROWS), (r) => r.at);
  const backPks = new Set(backs.map((b) => b.pk));
  const items: FeedItem[] = [...momentItems(ctx)];
  for (const row of effects) {
    const item = effectItem(row, ctx.boost);
    if (item !== null) items.push(item);
  }
  for (const b of backs) {
    const afterMs = b.dated && b.followedAt !== null ? b.at - b.followedAt : null;
    items.push({ id: `followed-back:${b.pk}:${b.at}`, at: b.at, kind: 'followed-back', person: personOf(b), afterMs, dated: b.dated });
  }
  for (const f of fresh) {
    if (!backPks.has(f.pk)) {
      items.push({ id: `new-follower:${f.pk}:${f.at}`, at: f.at, kind: 'new-followers', people: [personOf(f)], dated: f.dated });
    }
  }
  for (const l of reads.lostFollowerCount(ctx.ownPk, windowStart)) {
    items.push({ id: `lost:${l.at}`, at: l.at, kind: 'lost-followers', count: l.count });
  }
  const horizon = Math.max(windowStart, ...cuts);
  return [...new Map(items.filter((i) => i.at >= horizon).map((i) => [i.id, i])).values()];
}

/** The people a grouping row lists; none for a row that never groups. */
function peopleOf(item: FeedItem): readonly Person[] {
  return item.kind === 'followed' || item.kind === 'unfollowed' || item.kind === 'new-followers' ? item.people : [];
}

/** What a row must share with its neighbour to join its group; null for a row that never groups. */
function groupKey(item: FeedItem): string | null {
  if (item.kind === 'followed') return `followed|${item.via}|${item.practice}`;
  if (item.kind === 'unfollowed') return `unfollowed|${item.why}|${item.practice}`;
  return item.kind === 'new-followers' ? `new-followers|${item.dated}` : null;
}

/**
 * Oldest first, so a group only ever grows at its newest end and keeps its OLDEST member's id: a row joins the
 * previous one when it shares its key, the group still spans one session boundary, and the group has room.
 */
function group(oldestFirst: readonly FeedItem[]): FeedItem[] {
  const groups: { key: string | null; oldestAt: number; item: FeedItem }[] = [];
  for (const row of oldestFirst) {
    const key = groupKey(row);
    const last = groups[groups.length - 1];
    const g = last?.item;
    const joins = key !== null && last !== undefined && last.key === key && row.at - last.oldestAt <= LIVE.GROUP_WINDOW_MS
      && peopleOf(last.item).length < LIVE.GROUP_PEOPLE_MAX;
    if (joins && (g?.kind === 'followed' || g?.kind === 'unfollowed' || g?.kind === 'new-followers')) {
      last.item = { ...g, at: row.at, people: [...peopleOf(row), ...g.people] };
    } else groups.push({ key, oldestAt: row.at, item: row });
  }
  return groups.map((g) => g.item);
}

/** Today's plan-day and every earlier one that began inside the feed window: today first. */
export function feedDays(clock: Pick<PlanDayClock, 'window'>, now: number): FeedDay[] {
  const floor = now - LIVE.FEED_WINDOW_MS;
  let day = clock.window(now);
  const days: FeedDay[] = [{ key: day.key, startsAt: day.startsAt }];
  for (;;) {
    const before = clock.window(day.startsAt - 1);
    if (before.startsAt < floor || before.startsAt >= day.startsAt) return days;
    days.push({ key: before.key, startsAt: before.startsAt });
    day = before;
  }
}

/** The previous view when only the shaping instant moved, so the deduplicated feed row sends nothing. */
export function keepShapedAt(prev: FeedView | null, next: FeedView): FeedView {
  if (prev === null) return next;
  return JSON.stringify({ ...prev, shapedAt: 0 }) === JSON.stringify({ ...next, shapedAt: 0 }) ? prev : next;
}

/** The feed over whole plan-days: grouped, newest first, at most `LIVE.FEED_LIMIT` rows. */
export function shapeFeed(reads: FeedReads, ctx: FeedContext): FeedView {
  const days = feedDays(ctx.planDay, ctx.now);
  const windowStart = days[days.length - 1].startsAt;
  const oldestFirst = readItems(reads, ctx, windowStart)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const items = group(oldestFirst).reverse().slice(0, LIVE.FEED_LIMIT);
  return { items, awayFrom: ctx.awayFrom, windowStart, shapedAt: ctx.now, days };
}
