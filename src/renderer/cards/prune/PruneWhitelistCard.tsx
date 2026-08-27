/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from '@/renderer/ui/Button';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Icon } from '@/renderer/ui/Icon';
import type { Settings } from '@/types';

export interface PruneWhitelistCardProps {
  /** The persisted whitelist (usernames, matched case-insensitively). */
  whitelist: string[];
  /** Bio words/phrases that protect an account from prune unfollows. */
  bioFilterWords: string[];
  /** Persist a partial settings change (the view saves + relays onSaved). */
  onSave(part: Partial<Settings>): void;
}

/**
 * Prune · Whitelist — accounts that are never pruned. Add via the input
 * (Enter or the + button; trimmed, lowercased, deduped) and remove by clicking
 * an entry's chip. Every change persists immediately through `settings:update`.
 * Below it, the bio filter: words/phrases that protect any account whose
 * profile bio contains one (checked just before each unfollow).
 */
export function PruneWhitelistCard({
  whitelist,
  bioFilterWords,
  onSave,
}: PruneWhitelistCardProps): h.JSX.Element {
  const [value, setValue] = useState('');
  const clean = value.trim().replace(/^@/, '').toLowerCase();

  const add = (): void => {
    if (!clean) return;
    setValue('');
    if (whitelist.some((u) => u.toLowerCase() === clean)) return;
    onSave({ pruneWhitelist: [...whitelist, clean] });
  };

  const remove = (username: string): void => {
    onSave({ pruneWhitelist: whitelist.filter((u) => u !== username) });
  };

  const [wordValue, setWordValue] = useState('');
  const cleanWord = wordValue.trim().toLowerCase();

  const addWord = (): void => {
    if (!cleanWord) return;
    setWordValue('');
    if (bioFilterWords.some((w) => w.toLowerCase() === cleanWord)) return;
    onSave({ pruneBioFilterWords: [...bioFilterWords, cleanWord] });
  };

  const removeWord = (word: string): void => {
    onSave({ pruneBioFilterWords: bioFilterWords.filter((w) => w !== word) });
  };

  return (
    <Card index={2}>
      <CardHeader icon="shield-halved" aux={whitelist.length > 0 ? `${whitelist.length} protected` : undefined}>
        Prune · Whitelist
      </CardHeader>
      <Field
        label="Protected accounts"
        htmlFor="wlInput"
        tip="Accounts on this list are never unfollowed by a prune run, even when they don't follow you back — friends, brands, accounts you follow on purpose."
      >
        <div class="wl-add">
          <input
            class="tinput"
            type="text"
            id="wlInput"
            value={value}
            placeholder="@username"
            spellcheck={false}
            autocomplete="off"
            aria-label="Username to protect"
            onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button icon="plus" title="Add to whitelist" disabled={!clean} onClick={add}>
            Add
          </Button>
        </div>
        {whitelist.length > 0 ? (
          <div class="chips wl-chips">
            {whitelist.map((u) => (
              <button
                key={u}
                type="button"
                class="chip wl-chip"
                aria-label={`Remove @${u} from the whitelist`}
                onClick={() => remove(u)}
              >
                @{u}
                <Icon name="xmark" />
              </button>
            ))}
          </div>
        ) : (
          <div class="hint">No protected accounts yet.</div>
        )}
        <div class="hint">
          Whitelisted accounts are never pruned — the candidate list updates immediately.
        </div>
      </Field>
      <Field
        label="Protected bio words"
        htmlFor="bioWordInput"
        tip="Anyone whose profile bio contains one of these words or phrases is never unfollowed by a prune run. Matched anywhere in the bio, ignoring case."
      >
        <div class="wl-add">
          <input
            class="tinput"
            type="text"
            id="bioWordInput"
            value={wordValue}
            placeholder="word or phrase"
            spellcheck={false}
            autocomplete="off"
            aria-label="Bio word or phrase to protect"
            onInput={(e) => setWordValue((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addWord();
              }
            }}
          />
          <Button icon="plus" title="Add protected bio word" disabled={!cleanWord} onClick={addWord}>
            Add
          </Button>
        </div>
        {bioFilterWords.length > 0 ? (
          <div class="chips wl-chips">
            {bioFilterWords.map((w) => (
              <button
                key={w}
                type="button"
                class="chip wl-chip"
                aria-label={`Remove "${w}" from the protected bio words`}
                onClick={() => removeWord(w)}
              >
                {w}
                <Icon name="xmark" />
              </button>
            ))}
          </div>
        ) : (
          <div class="hint">No protected bio words yet.</div>
        )}
        <div class="hint">
          Bios are checked just before each unfollow, so matches are honored even when a
          bio was unknown at scan time.
        </div>
      </Field>
    </Card>
  );
}
