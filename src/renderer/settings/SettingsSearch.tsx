/**
 * The Settings search box (spec §6.5): `/` or ⌘F focuses it while Settings shows; results list as you
 * type (arrows move, Enter opens, Esc clears); a hit scrolls to its row and highlights it, switching to
 * Advanced first when only Advanced has it ("In Advanced → Finding new people · Show").
 */
import type { JSX } from 'preact';
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { stageSignal } from '@/renderer/app/shell-context';
import { Icon } from '@/renderer/ui/Icon';
import { STAGE_COPY } from './copy/sections';
import { fill } from './format';
import { type SearchHit, searchSettings } from './search';
import type { StageApi } from './stage-api';

/** `/` (outside a text field) or ⌘F / Ctrl+F. */
function wantsSearch(e: KeyboardEvent): boolean {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') return true;
  const t = e.target as HTMLElement | null;
  const typing = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  return e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export function SettingsSearch({ s }: { s: StageApi }): JSX.Element {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchSettings(q, s.view, s.mode), [q, s.view, s.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (stageSignal.peek() !== 'settings' || !wantsSearch(e)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const open = (h: SearchHit): void => {
    if (h.inAdvanced) s.openAdvanced(h.target.section, h.target.row);
    else s.scrollTo(h.target.section, h.target.row);
    setQ('');
    setActive(0);
  };
  const listed = q.trim() !== '';
  return (
    <div class="set-search">
      <Icon name="magnifying-glass" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label={STAGE_COPY.search}
        aria-expanded={listed && hits.length > 0}
        aria-controls={`${id}-hits`}
        aria-autocomplete="list"
        aria-activedescendant={listed && hits.length > 0 ? `${id}-h${active}` : undefined}
        placeholder={STAGE_COPY.search}
        value={q}
        onInput={(e) => {
          setQ((e.currentTarget as HTMLInputElement).value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && hits.length > 0) {
            e.preventDefault();
            setActive((active + 1) % hits.length);
          } else if (e.key === 'ArrowUp' && hits.length > 0) {
            e.preventDefault();
            setActive((active - 1 + hits.length) % hits.length);
          } else if (e.key === 'Enter' && hits[active] !== undefined) {
            e.preventDefault();
            open(hits[active] as SearchHit);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setQ('');
          }
        }}
      />
      <kbd title={STAGE_COPY.searchKey}>/</kbd>
      {listed ? (
        <div class="set-search__hits" id={`${id}-hits`} role="listbox" aria-label={STAGE_COPY.search}>
          {hits.length === 0 ? <p class="set-search__none">{fill(STAGE_COPY.searchEmpty, { q })}</p> : null}
          {hits.map((h, i) => (
            <div
              key={`${h.target.section}|${h.target.row ?? ''}`}
              id={`${id}-h${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              class={i === active ? 'set-search__hit is-active' : 'set-search__hit'}
              onMouseDown={(e) => {
                e.preventDefault();
                open(h);
              }}
            >
              <span class="set-search__title">{h.title}</span>
              <span class="set-search__where">
                {h.inAdvanced ? `${fill(STAGE_COPY.searchInAdvanced, { section: h.sectionTitle })} · ${STAGE_COPY.show}` : h.sectionTitle}
              </span>
              {h.note ? <span class="set-search__note">{h.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      <span class="sr-only" role="status" aria-live="polite">
        {listed ? (hits.length === 0 ? fill(STAGE_COPY.searchEmpty, { q }) : fill(STAGE_COPY.searchCount, { n: hits.length })) : ''}
      </span>
    </div>
  );
}
