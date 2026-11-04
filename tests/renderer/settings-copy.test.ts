/**
 * The Settings copy decks (spec §6.4, Appendix B.10): the "Recommended" tags mark exactly the fresh
 * document's choices, no deck carries a number that belongs to the view, and the user-facing word for the
 * cleanup feature is Prune (spec §18.3, Q28).
 */
import { BOOST_COPY } from '@/renderer/copy/boost';
import * as choices from '@/renderer/settings/copy/choices';
import * as fields from '@/renderer/settings/copy/fields';
import * as notices from '@/renderer/settings/copy/notices';
import * as params from '@/renderer/settings/copy/params';
import * as sections from '@/renderer/settings/copy/sections';
import { RECOMMENDED_INTENT } from '@/settings/doc';
import { PACE_CARDS } from '@/shared/settings-intent';

/** Every string in a deck, flattened. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (v !== null && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

/** The user-facing decks: every `*_COPY` table (data such as RECOMMENDED holds kernel keys, not words). */
const DECKS = [choices, fields, notices, params, sections, { BOOST_COPY }].map((m) =>
  Object.fromEntries(Object.entries(m).filter(([k]) => /_COPY$|_ACTIONS$|_LABEL$/.test(k))));

describe('the Settings copy', () => {
  it('marks the fresh document’s choices as recommended', () => {
    for (const [k, v] of Object.entries(choices.RECOMMENDED.intent)) {
      expect([k, RECOMMENDED_INTENT[k as keyof typeof RECOMMENDED_INTENT]]).toEqual([k, v]);
    }
    const card = PACE_CARDS[choices.RECOMMENDED.pace];
    expect([card.activity, card.caution]).toEqual([RECOMMENDED_INTENT.activity, RECOMMENDED_INTENT.caution]);
  });

  it('says Prune, never "clean up" or "whitelist", to the user', () => {
    const all = DECKS.flatMap(strings);
    expect(all.filter((t) => /clean[ -]?up|whitelist/i.test(t))).toEqual([]);
  });

  it('uses neutral words only', () => {
    const banned = /\b(bot|automation|human|natural|stealth|mimic|detect\w*|jitter|velocity|ban|flagged)\b/i;
    expect(DECKS.flatMap(strings).filter((t) => banned.test(t))).toEqual([]);
  });

  it('keeps a pace’s or a limit’s numbers out of the decks (they come from the view)', () => {
    const digits = DECKS.flatMap(strings).filter((t) => /\d/.test(t.replace(/\{\w+\}/g, '')));
    expect(digits).toEqual([]);
  });
});
