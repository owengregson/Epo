/** @jsx h */
import { h } from 'preact';
import { useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Button } from '@/renderer/ui/Button';
import { Field } from '@/renderer/ui/Field';
import { Icon } from '@/renderer/ui/Icon';

export interface PruneWhitelistCardProps {
  /** The persisted whitelist (usernames, matched case-insensitively). */
  whitelist: string[];
  /** Persist a partial settings change (the view saves + relays onSaved). */
  onSave(part: Partial<Settings>): void;
}

/**
 * Prune · Whitelist — accounts that are never pruned. Add via the input
 * (Enter or the + button; trimmed, lowercased, deduped) and remove by clicking
 * an entry's chip. Every change persists immediately through `settings:update`.
 */
export function PruneWhitelistCard({ whitelist, onSave }: PruneWhitelistCardProps): h.JSX.Element {
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

  return (
    <Card index={3}>
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
          Whitelisted accounts are never pruned. Re-scan after changes to refresh the candidate list.
        </div>
      </Field>
    </Card>
  );
}
