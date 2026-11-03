/**
 * The protection list ops (spec §6.7, §7.7): keyed adds and removes (no lost update on a list), restore,
 * the two rules, and the system-only pk link that tracks renames. Each returns the next protection and
 * the ops that undo it; handles go through the one `normalizeHandle`, words through the one `foldText`.
 */
import type { KeepWord, ProtectedAccount, ProtectionSettings } from '@/shared/settings-model';
import type { Adjustment, SettingsOp } from '@/shared/settings-ops';
import { foldText, normalizeHandle } from '@/shared/unfollow-protection';

export interface ProtectionStep {
  readonly protection: ProtectionSettings;
  readonly inverse: readonly SettingsOp[];
  readonly adjustments: readonly Adjustment[];
}

type ProtectionOp = Extract<SettingsOp, {
  op: 'protect-add' | 'protect-remove' | 'protect-restore' | 'word-add' | 'word-remove' | 'protect-rule' | 'protect-link';
}>;

const ALL_DIGITS = /^\d+$/;
const wordKey = (text: string): string => foldText(text).trim();
const sameAccount = (a: ProtectedAccount, b: ProtectedAccount): boolean =>
  a.username === b.username || (a.pk !== null && a.pk === b.pk);
const matches = (a: ProtectedAccount, m: { readonly pk?: string; readonly username?: string }): boolean =>
  (m.pk !== undefined && a.pk === m.pk) || (m.username !== undefined && a.username === normalizeHandle(m.username).handle);

function restore(p: ProtectionSettings, accounts: readonly ProtectedAccount[], words: readonly KeepWord[]): ProtectionStep {
  const addA = accounts.filter((a, i) => !p.accounts.some((b) => sameAccount(a, b)) && accounts.findIndex((b) => sameAccount(a, b)) === i);
  const addW = words.filter((w, i) => wordKey(w.text) !== '' && !p.words.some((x) => wordKey(x.text) === wordKey(w.text))
    && words.findIndex((x) => wordKey(x.text) === wordKey(w.text)) === i);
  return {
    protection: { ...p, accounts: [...p.accounts, ...addA], words: [...p.words, ...addW] },
    inverse: [
      ...addA.map((a) => ({ op: 'protect-remove', match: { username: a.username } }) as const),
      ...addW.map((w) => ({ op: 'word-remove', text: w.text }) as const),
    ],
    adjustments: [],
  };
}

/** Apply one protection op at `now`. */
export function applyProtectionOp(p: ProtectionSettings, op: ProtectionOp, now: number): ProtectionStep {
  switch (op.op) {
    case 'protect-add': {
      const adjustments: Adjustment[] = [];
      const accounts = op.entries.map((e): ProtectedAccount => {
        const { handle, valid } = normalizeHandle(e.username);
        if (handle !== e.username) adjustments.push({ key: 'protection', requested: e.username, applied: handle, because: 'normalized' });
        const pk = e.pk ?? (ALL_DIGITS.test(handle) ? handle : null);
        return { pk, username: handle, linkedAt: e.pk === undefined ? null : now, formerUsernames: [], addedAt: now, source: op.source, valid };
      }).filter((a) => a.username !== '');
      const step = restore(p, accounts, []);
      return { ...step, adjustments };
    }
    case 'protect-remove': {
      const removed = p.accounts.filter((a) => matches(a, op.match));
      return {
        protection: { ...p, accounts: p.accounts.filter((a) => !matches(a, op.match)) },
        inverse: removed.length === 0 ? [] : [{ op: 'protect-restore', accounts: removed, words: [] }],
        adjustments: [],
      };
    }
    case 'protect-restore':
      return restore(p, op.accounts, op.words);
    case 'word-add':
      return restore(p, [], op.texts.map((t) => ({ text: t.trim(), addedAt: now })));
    case 'word-remove': {
      const removed = p.words.filter((w) => wordKey(w.text) === wordKey(op.text));
      return {
        protection: { ...p, words: p.words.filter((w) => wordKey(w.text) !== wordKey(op.text)) },
        inverse: removed.length === 0 ? [] : [{ op: 'protect-restore', accounts: [], words: removed }],
        adjustments: [],
      };
    }
    case 'protect-rule':
      return op.rule === 'keepVerified'
        ? { protection: { ...p, keepVerified: op.value }, inverse: [{ op: 'protect-rule', rule: 'keepVerified', value: p.keepVerified }], adjustments: [] }
        : { protection: { ...p, wordMatch: op.value }, inverse: [{ op: 'protect-rule', rule: 'wordMatch', value: p.wordMatch }], adjustments: [] };
    case 'protect-link':
      return { protection: { ...p, accounts: p.accounts.map((a) => linked(a, op)) }, inverse: [], adjustments: [] };
  }
}

/**
 * Confirm a pk for its username: an entry with that pk follows a rename (the old name kept for display); an
 * unlinked entry with that username takes the pk. A linked entry already current is returned unchanged.
 */
function linked(a: ProtectedAccount, op: Extract<SettingsOp, { op: 'protect-link' }>): ProtectedAccount {
  const username = normalizeHandle(op.username).handle;
  if (a.pk === op.pk) {
    if (a.username === username && a.linkedAt !== null) return a;
    const formerUsernames = a.username === username ? a.formerUsernames : [...a.formerUsernames, a.username];
    return { ...a, username, linkedAt: op.at, formerUsernames };
  }
  return a.pk === null && a.username === username ? { ...a, pk: op.pk, linkedAt: op.at } : a;
}
