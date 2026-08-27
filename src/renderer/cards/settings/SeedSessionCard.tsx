/** @jsx h */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import { useSeedCheck } from '@/renderer/hooks/useSeedCheck';
import type { SettingsDraftController } from '@/renderer/hooks/useSettingsDraft';
import type { ViewKey } from '@/renderer/hooks/useView';
import { Button } from '@/renderer/ui/Button';
import { Card, CardHeader } from '@/renderer/ui/Card';
import { Field } from '@/renderer/ui/Field';
import { Icon } from '@/renderer/ui/Icon';
import type { Settings } from '@/types';

export interface SeedSessionCardProps {
  draft: Settings;
  patch: SettingsDraftController['patch'];
  confirm(options: ConfirmOptions): Promise<boolean>;
  goTo(view: ViewKey): void;
  /** Bumped when Start was pressed without a seed — flags + focuses the field. */
  requiredPrompt: number;
}

/**
 * Seed · Session — live seed-validity check plus the restart-from-seed action.
 * The input verifies through `seed:check` (debounced) and the destructive
 * restart is gated behind a verified seed + the shared confirm modal.
 */
export function SeedSessionCard({
  draft,
  patch,
  confirm,
  goTo,
  requiredPrompt,
}: SeedSessionCardProps): h.JSX.Element {
  const seed = useSeedCheck(draft.seed);
  const clean = seed.value.trim().replace(/^@/, '');
  const inputRef = useRef<HTMLInputElement>(null);
  // "Seed is required." state — raised when Start was pressed with a blank seed,
  // cleared as soon as the user edits the field (a fresh edit means they're on it).
  const [required, setRequired] = useState(false);

  useEffect(() => {
    if (requiredPrompt > 0) {
      setRequired(true);
      inputRef.current?.focus();
    }
  }, [requiredPrompt]);

  // Adopt EXTERNAL seed changes (e.g. a settings reset that already persisted):
  // `useSeedCheck` seeds its value once at mount, so after a reset the field —
  // and the auto-persist effect below — used to shove the OLD seed straight
  // back over the freshly-reset settings. `lastSeen` tracks the last draft
  // value this card itself produced; any other change is external.
  const lastSeen = useRef(draft.seed);
  useEffect(() => {
    if (draft.seed !== lastSeen.current) {
      lastSeen.current = draft.seed;
      seed.setValue(draft.seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.seed]);

  // A verified seed persists right away (via the draft autosave) — Start checks
  // the saved settings, so a seed living only in this field would still trip
  // the "Seed is required." guard.
  useEffect(() => {
    if (seed.valid && clean !== draft.seed) {
      lastSeen.current = clean;
      patch({ seed: clean });
    }
  }, [seed.valid, clean, draft.seed, patch]);

  const invalid = required || seed.status === 'invalid';
  const inputClass = `tinput${invalid ? ' invalid' : seed.status === 'valid' ? ' valid' : ''}`;
  const statusClass = seed.status === 'idle' ? 'seed-status' : `seed-status show ${seed.status}`;

  const restart = async (): Promise<void> => {
    const ok = await confirm({
      title: `Restart from @${clean}?`,
      body: 'This scraps the current session and starts a new chain from this seed.',
      confirm: 'Restart',
      danger: true,
    });
    if (!ok) return;
    lastSeen.current = clean;
    patch({ seed: clean }); // keep the local draft in step (the backend persists too)
    // The EXPLICIT restart: persists the seed main-side (no autosave debounce
    // race), retires the active chain, and starts fresh — a bare startEngine()
    // used to just resume the existing chain with the previous seed.
    await window.epo.restartFromSeed(clean);
    goTo('overview');
  };

  return (
    <Card raised index={0}>
      <CardHeader icon="seedling">Seed · Session</CardHeader>
      <Field
        label="Seed username"
        htmlFor="seedInput"
        tip="The first account whose followers are harvested. Pick one whose audience matches who you want to attract — the whole chain inherits its flavor."
      >
        <div class="seedwrap">
          <input
            ref={inputRef}
            class={inputClass}
            type="text"
            id="seedInput"
            value={seed.value}
            placeholder="@username"
            spellcheck={false}
            autocomplete="off"
            aria-label="Seed username"
            onInput={(e) => {
              setRequired(false);
              seed.setValue((e.currentTarget as HTMLInputElement).value);
            }}
          />
          <span class={statusClass} aria-hidden="true">
            {seed.status === 'checking' ? (
              <Icon name="spinner" spin />
            ) : seed.status === 'valid' ? (
              <Icon name="check" />
            ) : seed.status === 'invalid' ? (
              <Icon name="xmark" />
            ) : null}
          </span>
        </div>
        <div class="hint">The chain grows outward from this account’s followers.</div>
        <div class="hint alarm" role="alert" hidden={!invalid}>
          <Icon name="circle-exclamation" />
          <span>{required ? 'Seed is required.' : seed.message}</span>
        </div>
      </Field>
      <div class="field">
        <Button
          wide
          danger
          icon="arrows-rotate"
          disabled={!seed.valid}
          onClick={() => {
            void restart();
          }}
        >
          Restart from seed
        </Button>
        <div class="hint">Scraps the current session and starts a fresh chain from this seed.</div>
      </div>
    </Card>
  );
}
