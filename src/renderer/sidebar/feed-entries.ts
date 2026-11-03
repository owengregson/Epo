/**
 * The feed as the list renders it (spec §12.2): newest first, a header per plan-day ("Today", "Yesterday",
 * the weekday, the date) and the "Since you left" divider as a strict time boundary — every row above it
 * happened after you left. Pure, so the order is a test.
 */
import { sinceYouLeft } from '@/renderer/sidebar/copy/feed-copy';
import { dayHeader, weekdayTime } from '@/renderer/sidebar/format';
import type { FeedDay, FeedItem, FeedView } from '@/shared/feed';

export type FeedEntry =
  | { readonly kind: 'group'; readonly key: string; readonly label: string }
  | { readonly kind: 'divider'; readonly key: string; readonly label: string }
  | { readonly kind: 'row'; readonly key: string; readonly item: FeedItem };

/** Local calendar days, today first, when the feed carries no plan-days (before a build). */
function calendarDays(items: readonly FeedItem[], now: number): FeedDay[] {
  const oldest = items.reduce((m, i) => Math.min(m, i.at), now);
  const days: FeedDay[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  while (days.length === 0 || d.getTime() > oldest) {
    days.push({ key: d.toDateString(), startsAt: d.getTime() });
    d.setDate(d.getDate() - 1);
  }
  return days;
}

export function feedEntries(feed: FeedView, now: number): FeedEntry[] {
  const days = feed.days !== undefined && feed.days.length > 0 ? feed.days : calendarDays(feed.items, now);
  const out: FeedEntry[] = [];
  let day = -1;
  let dividerShown = feed.awayFrom === null;
  for (const item of feed.items) {
    if (!dividerShown && feed.awayFrom !== null && item.at < feed.awayFrom) {
      out.push({ kind: 'divider', key: `divider:${feed.awayFrom}`, label: sinceYouLeft(weekdayTime(feed.awayFrom)) });
      dividerShown = true;
    }
    const found = days.findIndex((d) => d.startsAt <= item.at);
    const at = found === -1 ? days.length - 1 : found;
    if (at !== day) {
      day = at;
      const d = days[at] as FeedDay;
      out.push({ kind: 'group', key: `day:${d.key}`, label: dayHeader(d.startsAt, at) });
    }
    out.push({ kind: 'row', key: item.id, item });
  }
  return out;
}
