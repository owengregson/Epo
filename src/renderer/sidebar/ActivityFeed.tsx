/**
 * Recent activity (spec §12.2, §12.7): a store-derived feed in the column's shared middle scroller. New
 * rows rise into place while the rows already there glide down (one FLIP per change; a single new follow or
 * unfollow travels from the now line into its row). Scrolled away, the view holds still and an "↑ N new"
 * pill offers the top. Rows are announced nowhere (`aria-live="off"`): the now line already says it.
 */
import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { feedSignal } from '@/renderer/app/live-signals';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { openPerson, openSettings } from '@/renderer/app/shell-services';
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

/** The compatibility panel lives in Settings › Advanced › Diagnostics. */
const openCompatibility = (): void => openSettings({ section: 'diagnostics', focus: 'compatibility' });

/** How far from its top the list may sit and still count as "at the top". */
const NEAR_TOP_PX = 8;

/** The middle always owns scrolling, so resizing never changes the feed's scroll owner. */
function scrollerOf(list: HTMLElement): HTMLElement | null {
  return list.closest<HTMLElement>('.sb-middle');
}

function awayFromTop(list: HTMLElement): boolean {
  const scroller = scrollerOf(list);
  if (scroller === null) return false;
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
    const tree = <FeedRows entries={entries} fresh={fresh} onPerson={openPerson} />;
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
    const scroller = el === null ? null : scrollerOf(el);
    const onScroll = (): void => {
      if (el !== null && !awayFromTop(el)) setUnseen(0);
    };
    scroller?.addEventListener('scroll', onScroll);
    return () => {
      scroller?.removeEventListener('scroll', onScroll);
      if (el !== null) render(null, el);
    };
  }, []);

  const toTop = (): void => {
    const el = list.current;
    const scroller = el === null ? null : scrollerOf(el);
    if (el !== null && scroller !== null) {
      const section = el.closest<HTMLElement>('.sb-feed') ?? el;
      const top = scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top, behavior: reducedMotionSignal.peek() ? 'instant' : 'smooth' });
    }
    setUnseen(0);
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
      <div class="sb-feed__list" ref={list} aria-live="off" />
    </section>
  );
}
