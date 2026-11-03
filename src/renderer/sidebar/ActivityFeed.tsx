/**
 * Recent activity (spec §12.2, §12.7): the column's only scroller, the store-derived feed as it grows. New
 * rows rise into place while the rows already there glide down (one FLIP per change; a single new follow or
 * unfollow travels from the now line into its row). Scrolled away, the view holds still and an "↑ N new"
 * pill offers the top. Rows are announced nowhere (`aria-live="off"`): the now line already says it.
 */
import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { feedSignal } from '@/renderer/app/live-signals';
import { openSettings, showStage } from '@/renderer/app/shell-services';
import { DUR } from '@/renderer/design/motion-scale';
import { flipInsert } from '@/renderer/lib/flip';
import { EASE_OUT } from '@/renderer/lib/motion';
import { CompatibilityNotice } from '@/renderer/live/CompatibilityNotice';
import { FEED_EMPTY } from '@/renderer/sidebar/copy/feed-copy';
import { FEED_TITLE, freshPill } from '@/renderer/sidebar/copy/zone-copy';
import { FeedRows } from '@/renderer/sidebar/FeedRows';
import { type FeedEntry, feedEntries } from '@/renderer/sidebar/feed-entries';
import { Icon } from '@/renderer/ui/Icon';
import type { FeedView } from '@/shared/feed';

const openPeople = (): void => showStage('people');
/** The compatibility panel lives in Settings › Advanced › Diagnostics. */
const openCompatibility = (): void => openSettings({ section: 'diagnostics', focus: 'compatibility' });

/** How far from its top the list may sit and still count as "at the top". */
const NEAR_TOP_PX = 8;

/** The element that scrolls the list: the list itself, or (in a short window) the column's middle. */
function scrollerOf(list: HTMLElement): HTMLElement | null {
  if (list.scrollHeight > list.clientHeight) return list;
  return list.closest<HTMLElement>('.sb-middle');
}

function awayFromTop(list: HTMLElement): boolean {
  const scroller = scrollerOf(list);
  if (scroller === null) return false;
  if (scroller === list) return list.scrollTop > NEAR_TOP_PX;
  return list.getBoundingClientRect().top < scroller.getBoundingClientRect().top - NEAR_TOP_PX;
}

const rowKeys = (entries: readonly FeedEntry[]): Set<string> =>
  new Set(entries.filter((e) => e.kind === 'row').map((e) => e.key));

export function ActivityFeed(): JSX.Element {
  const feed = feedSignal.value;
  const list = useRef<HTMLDivElement>(null);
  const drawn = useRef<{ feed: FeedView; keys: Set<string> } | null>(null);
  const [unseen, setUnseen] = useState(0);
  const now = Date.now();
  const entries = feed === null ? [] : feedEntries(feed, now);

  useLayoutEffect(() => {
    const el = list.current;
    if (el === null || feed === null || drawn.current?.feed === feed) return;
    const keys = rowKeys(entries);
    const before = drawn.current;
    const fresh = before === null ? new Set<string>() : new Set([...keys].filter((k) => !before.keys.has(k)));
    const tree = <FeedRows entries={entries} fresh={fresh} onPerson={openPeople} />;
    drawn.current = { feed, keys };
    if (before === null) {
      render(tree, el);
      return;
    }
    const away = awayFromTop(el);
    const scroller = scrollerOf(el);
    const anchor = away ? (el.querySelector<HTMLElement>('.sb-row') ?? null) : null;
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    const single = fresh.size === 1 ? entries.find((e) => e.kind === 'row' && fresh.has(e.key)) : undefined;
    const filed = single?.kind === 'row' && (single.item.kind === 'followed' || single.item.kind === 'unfollowed')
      ? document.querySelector('[data-now-line]')?.getBoundingClientRect() : undefined;
    flipInsert(el, () => {
      render(tree, el);
      // Scrolled away the view holds still: the rows above it grew, so the scroll follows them.
      if (anchor !== null && scroller !== null) scroller.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }, { duration: DUR[3], easing: EASE_OUT }, away || filed === undefined ? {} : { from: filed });
    if (away && fresh.size > 0) setUnseen((n) => n + fresh.size);
  }, [feed]);

  useEffect(() => {
    const el = list.current;
    return () => {
      if (el !== null) render(null, el);
    };
  }, []);

  const toTop = (): void => {
    const el = list.current;
    const scroller = el === null ? null : scrollerOf(el);
    scroller?.scrollTo({ top: 0, behavior: 'smooth' });
    setUnseen(0);
  };
  const onScroll = (): void => {
    if (unseen > 0 && list.current !== null && !awayFromTop(list.current)) setUnseen(0);
  };

  return (
    <section class="sb-zone sb-feed" data-zone="activity" data-tour="feed">
      <div class="sb-feed__head">
        <h3>{FEED_TITLE}</h3>
        {unseen > 0 ? (
          <button type="button" class="sb-pill sb-pill--new" onClick={toTop}>
            <Icon name="arrow-up" /> {freshPill(unseen)}
          </button>
        ) : null}
      </div>
      <CompatibilityNotice onDetails={openCompatibility} />
      {feed !== null && feed.items.length === 0 ? <p class="sb-feed__empty">{FEED_EMPTY}</p> : null}
      <div class="sb-feed__list" ref={list} aria-live="off" onScroll={onScroll} />
    </section>
  );
}
