/**
 * A sentence whose people are handle buttons: each opens the People page (spec §12.2). Text from a live-op
 * sentence is split on its "@handle"s, so the now line and the feed rows read the same way.
 */
import type { JSX } from 'preact';
import type { Part } from '@/renderer/sidebar/copy/feed-copy';
import { SOMEONE } from '@/renderer/sidebar/copy/feed-copy';
import type { Person } from '@/shared/feed';

const HANDLE = /(@[A-Za-z0-9._]*[A-Za-z0-9_])/;

/** A plain sentence as parts, its "@handle"s turned into people. */
export function partsOf(text: string): Part[] {
  return text.split(HANDLE).filter((s) => s !== '').map((s) => (HANDLE.test(s) ? { person: { pk: '', username: s.slice(1) } } : s));
}

export function Said({ parts, onPerson }: { parts: readonly Part[]; onPerson(p: Person): void }): JSX.Element {
  return (
    <>
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          <span key={`${i}:${part}`}>{part}</span>
        ) : part.person.username === null ? (
          <span key={`${i}:someone`}>{SOMEONE}</span>
        ) : (
          <button key={`${i}:${part.person.username}`} type="button" class="sb-handle" onClick={() => onPerson(part.person)}>
            @{part.person.username}
          </button>
        ),
      )}
    </>
  );
}
