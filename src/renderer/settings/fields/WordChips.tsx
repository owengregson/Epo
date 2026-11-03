/**
 * Bio keywords (spec §7.8): one chip per word with its live count over the stored bios of accounts you
 * follow ("photographer · 96 people", "—" until the store answers), an add field, and a remove per chip.
 */
import type { JSX } from 'preact';
import { type Token, TokenList } from '@/renderer/ui/TokenList';
import { foldText } from '@/shared/unfollow-protection';
import { PROTECTION_COPY } from '../copy/fields';
import { fill } from '../format';
import type { StageApi } from '../stage-api';
import { ControlError } from './controls';

const ADD = 'word:add:';
const REMOVE = 'word:remove:';

/** Several words at once: "family, photographer" adds two. */
export const splitWords = (text: string): string[] => text.split(/[,;\n]+/).map((w) => w.trim()).filter((w) => w !== '');

export function WordChips({ s }: { s: StageApi }): JSX.Element {
  const byWord = s.facts?.built ? (s.facts.protection?.byWord ?? null) : null;
  const overlay = s.c.state.overlay;
  const words = s.view.protection.words.filter((w) => !overlay.has(`${REMOVE}${w.text}`));
  const meta = (text: string): string => {
    const n = byWord?.[foldText(text)];
    if (n === undefined) return PROTECTION_COPY.wordUnknown;
    return fill(n === 1 ? PROTECTION_COPY.wordPerson : PROTECTION_COPY.wordPeople, { n });
  };
  const pending = [...overlay.entries()].filter(([k]) => k.startsWith(ADD)).flatMap(([, v]) => v as string[]);
  const tokens: Token[] = [
    ...words.map((w) => ({ key: w.text, label: w.text, meta: meta(w.text) })),
    ...pending.filter((p) => !words.some((w) => foldText(w.text) === foldText(p))).map((p) => ({ key: `+${p}`, label: p, pending: true })),
  ];
  const failed = [...s.c.state.errors.keys()].find((k) => k.startsWith(ADD) || k.startsWith(REMOVE));
  return (
    <div class="set-words" data-row="protection.words">
      <TokenList
        label={PROTECTION_COPY.words}
        tokens={tokens}
        addLabel={PROTECTION_COPY.wordAdd}
        addButton={PROTECTION_COPY.addButton}
        removeLabel={(t) => fill(PROTECTION_COPY.removeWord, { w: t.label })}
        onAdd={(text) => {
          const texts = splitWords(text);
          if (texts.length > 0) s.send(`${ADD}${texts.join(',')}`, [{ op: 'word-add', texts }], texts);
        }}
        onRemove={(t) => {
          if (!t.pending) s.send(`${REMOVE}${t.key}`, [{ op: 'word-remove', text: t.key }], true);
        }}
      />
      {failed === undefined ? null : <ControlError s={s} k={failed} />}
    </div>
  );
}
