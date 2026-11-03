/**
 * Protected people (spec §7.8): an "Add @username" combobox over the accounts you follow (store-only
 * suggestions), Paste a list, and one row per entry with its standing from the facts. Removing shows an
 * inline Undo that sends main's own inverse. There is no "remove all".
 */
import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';
import { useSuggest } from '@/renderer/hooks/useSuggest';
import { monogram } from '@/renderer/lib/format';
import { Icon } from '@/renderer/ui/Icon';
import type { ProtectionFacts } from '@/shared/settings-facts';
import type { ProtectedAccount } from '@/shared/settings-model';
import { normalizeHandle } from '@/shared/unfollow-protection';
import { PROTECTION_COPY } from '../copy/fields';
import { fill } from '../format';
import type { StageApi } from '../stage-api';
import { ControlError } from './controls';

const ADD = 'protect:add:';
const REMOVE = 'protect:remove:';
/** A username is at most 30 characters; longer text cannot match anyone. */
const HANDLE_MAX = 30;

type Entry = ProtectionFacts['entries'][string];

/** Every handle in a pasted list: split on spaces, commas, semicolons and new lines. */
export function parseHandles(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const h = part.trim().replace(/^@+/, '').toLowerCase();
    if (h !== '') seen.add(h);
  }
  return [...seen];
}

function badges(a: ProtectedAccount, e: Entry | undefined): string[] {
  const out: string[] = [];
  if (!a.valid || e?.status === 'invalid') return [PROTECTION_COPY.invalid];
  if (e?.status === 'not-seen') out.push(PROTECTION_COPY.notSeen);
  if (e?.status === 'not-followed') out.push(PROTECTION_COPY.notFollowed);
  const rel = [e?.youFollow ? PROTECTION_COPY.follows : null, e?.followsYou ? PROTECTION_COPY.followsYou : null];
  const relation = rel.filter((x) => x !== null).join(' · ');
  if (relation !== '') out.push(relation);
  const old = a.formerUsernames.at(-1);
  if (old !== undefined) out.push(fill(PROTECTION_COPY.renamed, { old }));
  return out;
}

function Row({ a, e, onRemove }: { a: ProtectedAccount; e: Entry | undefined; onRemove(): void }): JSX.Element {
  const name = e?.currentUsername ?? a.username;
  return (
    <li class="set-person">
      <span class="set-person__mono" aria-hidden="true">
        {monogram(name)}
      </span>
      <span class="set-person__who">
        <span class="set-person__name">@{name}</span>
        <span class="set-person__badges">
          {badges(a, e).map((b) => (
            <span key={b} class="set-tag">
              {b}
            </span>
          ))}
        </span>
      </span>
      <button type="button" class="set-icon-btn" aria-label={fill(PROTECTION_COPY.remove, { u: name })} onClick={onRemove}>
        <Icon name="xmark" />
      </button>
    </li>
  );
}

export function PeopleList({ s }: { s: StageApi }): JSX.Element {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pasting, setPasting] = useState<string | null>(null);
  const suggest = useSuggest(query.slice(0, HANDLE_MAX));
  const accounts = s.view.protection.accounts;
  const entries = s.facts?.built ? (s.facts.protection?.entries ?? {}) : {};
  const overlay = s.c.state.overlay;
  const removing = new Set([...overlay.keys()].filter((k) => k.startsWith(REMOVE)).map((k) => k.slice(REMOVE.length)));
  const adding = [...overlay.entries()].filter(([k]) => k.startsWith(ADD)).flatMap(([, v]) => v as string[]);
  const known = new Set(accounts.map((a) => a.username));
  const options = suggest.rows.filter((r) => !known.has(r.username));

  const add = (list: readonly { username: string; pk?: string }[]): void => {
    const fresh = list.filter((x) => !known.has(x.username));
    if (fresh.length === 0) return;
    s.send(`${ADD}${fresh.map((x) => x.username).join(',')}`, [{ op: 'protect-add', entries: fresh, source: 'you' }], fresh.map((x) => x.username));
  };
  const addTyped = (): void => {
    const pick = options[active];
    if (suggest.state === 'ok' && pick !== undefined && pick.username.startsWith(normalizeHandle(query).handle)) {
      add([{ username: pick.username, pk: pick.pk }]);
    } else {
      const h = normalizeHandle(query).handle;
      if (h !== '') add([{ username: h }]);
    }
    setQuery('');
    setActive(0);
  };
  const remove = (a: ProtectedAccount): void => {
    s.send(`${REMOVE}${a.username}`, [{ op: 'protect-remove', match: a.pk !== null ? { pk: a.pk } : { username: a.username } }], true);
  };
  const lastSave = s.c.state.save;
  const undoable = lastSave.kind === 'saved' && lastSave.key.startsWith(REMOVE) ? lastSave.key.slice(REMOVE.length) : null;
  const open = query.trim() !== '' && options.length > 0;
  const failed = [...s.c.state.errors.keys()].find((k) => k.startsWith(ADD) || k.startsWith(REMOVE));
  const shown = accounts.filter((a) => !removing.has(a.username));

  return (
    <div class="set-people" data-row="protection.people">
      <div class="set-combo">
        <input
          id={`${id}-q`}
          class="set-input"
          type="text"
          role="combobox"
          aria-label={PROTECTION_COPY.add}
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${id}-o${active}` : undefined}
          placeholder={PROTECTION_COPY.add}
          value={query}
          autocomplete="off"
          spellcheck={false}
          onInput={(e) => {
            setQuery((e.currentTarget as HTMLInputElement).value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && open) {
              e.preventDefault();
              setActive((active + 1) % options.length);
            } else if (e.key === 'ArrowUp' && open) {
              e.preventDefault();
              setActive((active - 1 + options.length) % options.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              addTyped();
            } else if (e.key === 'Escape') setQuery('');
          }}
        />
        <button type="button" class="set-btn" disabled={query.trim() === ''} onClick={addTyped}>
          {PROTECTION_COPY.addButton}
        </button>
        <button type="button" class="set-btn" aria-expanded={pasting !== null} onClick={() => setPasting(pasting === null ? '' : null)}>
          {PROTECTION_COPY.paste}
        </button>
        {open ? (
          <div class="set-combo__list" id={`${id}-list`} role="listbox" aria-label={PROTECTION_COPY.suggestions}>
            {options.map((r, i) => (
              <div
                key={r.pk}
                id={`${id}-o${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                class={i === active ? 'is-active' : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  add([{ username: r.username, pk: r.pk }]);
                  setQuery('');
                }}
              >
                <span>@{r.username}</span>
                {r.followsYou ? <span class="set-tag">{PROTECTION_COPY.followsYou}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {pasting !== null ? (
        <div class="set-paste">
          <label class="set-field__label" for={`${id}-paste`}>
            {PROTECTION_COPY.pasteLabel}
          </label>
          <textarea id={`${id}-paste`} class="set-input" rows={4} value={pasting} onInput={(e) => setPasting((e.currentTarget as HTMLTextAreaElement).value)} />
          <div class="set-paste__actions">
            <button
              type="button"
              class="set-btn set-btn--primary"
              disabled={parseHandles(pasting).length === 0}
              onClick={() => {
                add(parseHandles(pasting).map((h) => ({ username: normalizeHandle(h).handle || h })));
                setPasting(null);
              }}
            >
              {PROTECTION_COPY.pasteAdd}
            </button>
            <button type="button" class="set-btn" onClick={() => setPasting(null)}>
              {PROTECTION_COPY.pasteCancel}
            </button>
          </div>
        </div>
      ) : null}
      {shown.length === 0 && adding.length === 0 ? <p class="set-note">{PROTECTION_COPY.empty}</p> : (
        <ul class="set-people__list" aria-label={PROTECTION_COPY.people}>
          {shown.map((a) => <Row key={a.username} a={a} e={entries[a.username]} onRemove={() => remove(a)} />)}
          {adding.filter((u) => !known.has(u)).map((u) => (
            <li key={`adding-${u}`} class="set-person is-pending">
              <span class="set-person__mono" aria-hidden="true">{monogram(u)}</span>
              <span class="set-person__who"><span class="set-person__name">@{u}</span></span>
            </li>
          ))}
        </ul>
      )}
      {undoable !== null ? (
        <p class="set-undo" role="status">
          {fill(PROTECTION_COPY.removed, { u: undoable })}{' '}
          <button type="button" class="link-btn" onClick={s.c.undo}>
            {PROTECTION_COPY.undo}
          </button>
        </p>
      ) : null}
      {failed === undefined ? null : <ControlError s={s} k={failed} />}
    </div>
  );
}
