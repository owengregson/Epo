import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';
import { Icon } from '@/renderer/ui/Icon';

export interface Token {
  readonly key: string;
  readonly label: string;
  /** A live count or note beside the label ("96 people"). */
  readonly meta?: string;
  readonly pending?: boolean;
}

export interface TokenListProps {
  label: string;
  tokens: readonly Token[];
  /** The add field's placeholder and accessible name. */
  addLabel: string;
  addButton: string;
  /** "Remove “family”" for a token. */
  removeLabel(t: Token): string;
  onAdd(text: string): void;
  onRemove(t: Token): void;
}

/**
 * Removable chips with one add field: Enter or the Add button adds what was typed; each chip has its own
 * labelled remove button. There is deliberately no "remove all".
 */
export function TokenList({ label, tokens, addLabel, addButton, removeLabel, onAdd, onRemove }: TokenListProps): JSX.Element {
  const id = useId();
  const [text, setText] = useState('');
  const add = (): void => {
    const t = text.trim();
    if (t === '') return;
    onAdd(t);
    setText('');
  };
  return (
    <div class="token-list">
      <ul class="token-list__items" aria-label={label}>
        {tokens.map((t) => (
          <li key={t.key} class={t.pending ? 'token is-pending' : 'token'}>
            <span class="token__label">{t.label}</span>
            {t.meta ? <span class="token__meta num">{t.meta}</span> : null}
            <button type="button" class="token__remove" aria-label={removeLabel(t)} onClick={() => onRemove(t)}>
              <Icon name="xmark" />
            </button>
          </li>
        ))}
      </ul>
      <div class="token-list__add">
        <input
          id={`${id}-add`}
          class="set-input"
          type="text"
          value={text}
          placeholder={addLabel}
          aria-label={addLabel}
          autocomplete="off"
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
            if (e.key === 'Escape') setText('');
          }}
        />
        <button type="button" class="set-btn" onClick={add} disabled={text.trim() === ''}>
          {addButton}
        </button>
      </div>
    </div>
  );
}
