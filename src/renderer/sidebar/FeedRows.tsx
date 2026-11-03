/**
 * The feed's rows (spec §12.2, C.15.6): a tone disc and glyph, the sentence with its handles, a detail line
 * where the deck has one, and the row's time from the minute clock. A grouped row expands on click to list
 * its people. Rendered into the list as its own root, so the list can glide rows into place around a change.
 */
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { useNow } from '@/renderer/app/clock';
import { rowFace } from '@/renderer/sidebar/copy/feed-copy';
import type { FeedEntry } from '@/renderer/sidebar/feed-entries';
import { Said } from '@/renderer/sidebar/Said';
import { Icon } from '@/renderer/ui/Icon';
import { type FeedItem, formatAgo, type Person } from '@/shared/feed';

function Row({ item, now, fresh, onPerson }: { item: FeedItem; now: number; fresh: boolean; onPerson(p: Person): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const face = rowFace(item);
  const people = face.people;
  const cls = ['sb-row', face.detail === null ? '' : 'is-two', fresh ? 'is-new' : '', open ? 'is-open' : ''].filter(Boolean).join(' ');
  return (
    <div class={cls} data-tone={face.tone} data-row={item.kind}>
      <div class="sb-row__main">
        <span class="sb-row__disc" aria-hidden="true">
          <Icon name={face.glyph} />
        </span>
        <span class="sb-row__text">
          <span class="sb-row__line">
            <Said parts={face.line} onPerson={onPerson} />
          </span>
          {face.detail === null ? null : (
            <span class="sb-row__detail">
              <Said parts={face.detail} onPerson={onPerson} />
            </span>
          )}
        </span>
        <time class="num" dateTime={new Date(item.at).toISOString()}>{formatAgo(item.at, now)}</time>
        {people === null ? null : (
          <button type="button" class="sb-row__more" aria-expanded={open ? 'true' : 'false'} aria-label={open ? 'Show less' : 'Show everyone'}
            onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'chevron-up' : 'chevron-down'} />
          </button>
        )}
      </div>
      {open && people !== null ? (
        <p class="sb-row__people">
          {/* Main closes a group at the live policy's people bound, so the whole group fits here. */}
          <Said parts={people.flatMap((x, i) => (i === 0 ? [{ person: x }] : [', ', { person: x }]))} onPerson={onPerson} />
        </p>
      ) : null}
    </div>
  );
}

export interface FeedRowsProps {
  readonly entries: readonly FeedEntry[];
  /** Rows that arrived since the list was last drawn (highlighted while their arrival fades). */
  readonly fresh: ReadonlySet<string>;
  onPerson(p: Person): void;
}

export function FeedRows({ entries, fresh, onPerson }: FeedRowsProps): JSX.Element {
  const now = useNow('minute');
  return (
    <>
      {entries.map((e) =>
        e.kind === 'row' ? (
          <Row key={e.key} item={e.item} now={now} fresh={fresh.has(e.key)} onPerson={onPerson} />
        ) : (
          <div key={e.key} class={e.kind === 'group' ? 'sb-feed__group' : 'sb-feed__divider'}>
            {e.label}
          </div>
        ),
      )}
    </>
  );
}
