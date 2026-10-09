import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Button } from '@/renderer/ui/Button';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Icon } from '@/renderer/ui/Icon';
import type { Settings } from '@/types';

export interface PruneWhitelistCardProps {
  /** The persisted whitelist (usernames, matched case-insensitively). */
  whitelist: string[];
  /** The bio keep-list: words that keep a FOLLOW-BACK followed (see below). */
  bioFilterWords: string[];
  /** Persist a partial settings change (the view saves + relays onSaved). */
  onSave(part: Partial<Settings>): void;
}

/**
 * Prune · Whitelist — accounts that are never pruned. Add via the input
 * (Enter or the + button; trimmed, lowercased, deduped) and remove by clicking
 * an entry's chip. Every change persists immediately through `settings:update`.
 * Below it, the bio keep-list: words/phrases that keep an account followed
 * ONLY when it follows you back (the churn rotation's keep gate) — someone
 * who doesn't follow back is pruned regardless of their bio.
 */
export function PruneWhitelistCard({
  whitelist,
  bioFilterWords,
  onSave,
}: PruneWhitelistCardProps): JSX.Element {
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
    <Card>
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
        label="Bio keep-words"
        htmlFor="bioWordInput"
        tip="Someone who FOLLOWS YOU BACK and whose bio contains one of these words or phrases stays followed — the rotation never unfollows them. Matched anywhere in the bio, ignoring case. Accounts that don't follow back are pruned regardless of bio."
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
            aria-label="Bio keep-word or phrase"
            onInput={(e) => setWordValue((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addWord();
              }
            }}
          />
          <Button icon="plus" title="Add bio keep-word" disabled={!cleanWord} onClick={addWord}>
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
                aria-label={`Remove "${w}" from the bio keep-words`}
                onClick={() => removeWord(w)}
              >
                {w}
                <Icon name="xmark" />
              </button>
            ))}
          </div>
        ) : (
          <div class="hint">No keep-words yet.</div>
        )}
        <div class="hint">
          Keeps mutuals you care about: a follow-back whose bio matches is held forever
          instead of being rotated out. It does not shield non-followers from a prune.
        </div>
      </Field>
    </Card>
  );
}
