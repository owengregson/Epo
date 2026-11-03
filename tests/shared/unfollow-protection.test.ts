/**
 * The protection predicate (spec §7.3): its truth table, and law L-PROT —
 * monotone in entries, words and rules; folding finds every match today's
 * lowercase substring test finds; no follow-back field on the subject.
 */

import fc from 'fast-check';
import { bioMatchesFilter } from '@/engine/prune-bio-filter';
import type { ProtectedAccount, ProtectionSettings } from '@/shared/settings-model';
import {
  compileProtection, foldText, normalizeHandle, type ProtectionSubject, type ProtectionVerdict, protectionVerdict,
} from '@/shared/unfollow-protection';

const account = (over: Partial<ProtectedAccount>): ProtectedAccount => ({
  pk: null, username: '', linkedAt: null, formerUsernames: [], addedAt: 0, source: 'you', valid: true, ...over,
});
const settings = (over: Partial<ProtectionSettings> = {}): ProtectionSettings => ({
  accounts: [], words: [], wordMatch: 'anywhere', keepVerified: false, ...over,
});
const subject = (over: Partial<ProtectionSubject> = {}): ProtectionSubject => ({
  pk: '100', username: 'jane', bio: '', isVerified: false, ...over,
});
const verdict = (s: Partial<ProtectionSubject>, p: Partial<ProtectionSettings>, state = 'ready' as const) =>
  protectionVerdict(subject(s), compileProtection(settings(p), state, 1));

describe('truth table', () => {
  test('a review or unavailable state pauses every subject, even a protected one', () => {
    const p = { accounts: [account({ pk: '100', username: 'jane' })] };
    expect(protectionVerdict(subject(), compileProtection(settings(p), 'needs-review', 1)))
      .toEqual({ kind: 'paused', state: 'needs-review' });
    expect(protectionVerdict(subject(), compileProtection(settings(), 'unavailable', 1)))
      .toEqual({ kind: 'paused', state: 'unavailable' });
  });

  test('people: by pk always; by handle only while unlinked', () => {
    expect(verdict({}, { accounts: [account({ pk: '100', username: 'old', linkedAt: 5 })] }))
      .toEqual({ kind: 'protected', by: 'account', match: '100' });
    expect(verdict({ username: 'Jane' }, { accounts: [account({ username: 'jane' })] }))
      .toEqual({ kind: 'protected', by: 'account', match: 'jane' });
    expect(verdict({}, { accounts: [account({ pk: '999', username: 'jane', linkedAt: 5 })] })).toEqual({ kind: 'clear' });
    // A migrated all-digit entry matches the pk or the handle, as the older whitelist did.
    expect(verdict({ pk: '7', username: '12345' }, { accounts: [account({ pk: '12345', username: '12345' })] }))
      .toEqual({ kind: 'protected', by: 'account', match: '12345' });
  });

  test('verified accounts are kept while the rule is on', () => {
    expect(verdict({ isVerified: true }, { keepVerified: true }))
      .toEqual({ kind: 'protected', by: 'verified', match: 'verified' });
    expect(verdict({ isVerified: true }, { keepVerified: false })).toEqual({ kind: 'clear' });
  });

  test('bio words match folded text anywhere, or bounded words only', () => {
    const words = [{ text: 'Café', addedAt: 0 }];
    expect(verdict({ bio: 'Owner of CAFE NOIR' }, { words })).toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
    expect(verdict({ bio: 'ｃａｆé lover' }, { words })).toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
    expect(verdict({ bio: 'cafeteria' }, { words, wordMatch: 'whole-word' })).toEqual({ kind: 'clear' });
    expect(verdict({ bio: 'my café.' }, { words, wordMatch: 'whole-word' }))
      .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
    expect(verdict({ bio: 'anything' }, { words: [{ text: '   ', addedAt: 0 }] })).toEqual({ kind: 'clear' });
  });

  test('unknown only when a configured rule lacks its fact; an observed empty bio is known', () => {
    const words = [{ text: 'shop', addedAt: 0 }];
    expect(verdict({ bio: undefined }, { words })).toEqual({ kind: 'unknown', missing: 'bio' });
    expect(verdict({ bio: '' }, { words })).toEqual({ kind: 'clear' });
    expect(verdict({ bio: undefined }, {})).toEqual({ kind: 'clear' });
    expect(verdict({ isVerified: undefined }, { keepVerified: true })).toEqual({ kind: 'unknown', missing: 'verified' });
    expect(verdict({ isVerified: undefined }, {})).toEqual({ kind: 'clear' });
  });

  test('precedence: protected beats unknown, account beats verified beats bio', () => {
    const words = [{ text: 'shop', addedAt: 0 }];
    expect(verdict({ isVerified: true, bio: undefined }, { keepVerified: true, words }).kind).toBe('protected');
    expect(verdict({ bio: 'my shop', isVerified: undefined }, { keepVerified: true, words }))
      .toEqual({ kind: 'protected', by: 'bio-word', match: 'shop' });
    expect(verdict({ isVerified: true, bio: 'shop' }, { keepVerified: true, words, accounts: [account({ pk: '100' })] }))
      .toEqual({ kind: 'protected', by: 'account', match: '100' });
  });
});

describe('helpers', () => {
  test('foldText strips accents, capitals and compatibility forms', () => {
    expect(foldText('Ｃａｆé ﬁne 𝐁𝐎𝐋𝐃')).toBe('cafe fine bold');
  });

  test('normalizeHandle trims, drops one @, lowercases, and checks the handle alphabet', () => {
    expect(normalizeHandle('  @Jane.Doe_1 ')).toEqual({ handle: 'jane.doe_1', valid: true });
    expect(normalizeHandle('jane doe')).toEqual({ handle: 'jane doe', valid: false });
    expect(normalizeHandle('x'.repeat(31))).toMatchObject({ valid: false });
  });
});

// --- L-PROT ------------------------------------------------------------------------------------

const ALPHABET = ['a', 'b', 'c', 'e', 'é', 'É', 'ü', 'ñ', 'ç', 'S', 'ﬁ', 'Ａ', '𝐀', '1', ' ', '.', '_'];
const text = (max: number) => fc.array(fc.constantFrom(...ALPHABET), { maxLength: max }).map((cs) => cs.join(''));
const handle = fc.constantFrom('jane', 'bob', 'shop.co', '12345', 'x_y');
const pkArb = fc.constantFrom('100', '200', '12345', '7');
const accountArb = fc.record({
  pk: fc.option(pkArb, { nil: null }), username: handle, linked: fc.boolean(),
}).map(({ pk, username, linked }) => account({ pk, username, linkedAt: linked && pk !== null ? 1 : null }));
const settingsArb = fc.record({
  accounts: fc.array(accountArb, { maxLength: 3 }),
  words: fc.array(text(4).map((t) => ({ text: t, addedAt: 0 })), { maxLength: 3 }),
  wordMatch: fc.constantFrom<'anywhere' | 'whole-word'>('anywhere', 'whole-word'),
  keepVerified: fc.boolean(),
});
const subjectArb = fc.record({
  pk: pkArb, username: fc.option(handle, { nil: null }),
  bio: fc.option(text(12), { nil: undefined }), isVerified: fc.option(fc.boolean(), { nil: undefined }),
});
/** One addition: an entry, a word, the verified rule, or the wider word match. */
const additionArb = fc.oneof(
  accountArb.map((a) => (p: ProtectionSettings): ProtectionSettings => ({ ...p, accounts: [...p.accounts, a] })),
  text(4).map((t) => (p: ProtectionSettings): ProtectionSettings => ({ ...p, words: [...p.words, { text: t, addedAt: 0 }] })),
  fc.constant((p: ProtectionSettings): ProtectionSettings => ({ ...p, keepVerified: true })),
  fc.constant((p: ProtectionSettings): ProtectionSettings => ({ ...p, wordMatch: 'anywhere' })),
);
const holds = (v: ProtectionVerdict): boolean => v.kind === 'protected' || v.kind === 'unknown';

test('L-PROT: adding an entry, a word or a rule never turns protected or unknown into clear', () => {
  fc.assert(fc.property(settingsArb, subjectArb, additionArb, (p, s, add) => {
    const before = protectionVerdict(s, compileProtection(p, 'ready', 1));
    const after = protectionVerdict(s, compileProtection(add(p), 'ready', 2));
    if (holds(before)) expect(holds(after)).toBe(true);
    if (before.kind === 'protected') expect(after.kind).toBe('protected');
  }), { numRuns: 500 });
});

test("L-PROT: folding finds every match today's lowercase substring test finds", () => {
  const word = fc.array(fc.constantFrom(...ALPHABET.filter((c) => c !== ' ')), { minLength: 1, maxLength: 3 })
    .map((cs) => cs.join(''));
  fc.assert(fc.property(text(14), word, (bio, w) => {
    if (!bioMatchesFilter(bio, [w])) return;
    const v = protectionVerdict(subject({ bio }), compileProtection(settings({ words: [{ text: w, addedAt: 0 }] }), 'ready', 1));
    expect(v).toMatchObject({ kind: 'protected', by: 'bio-word' });
  }), { numRuns: 1000 });
});

test('L-PROT: the subject carries no follow-back field', () => {
  const fields: Record<keyof ProtectionSubject, true> = { pk: true, username: true, bio: true, isVerified: true };
  expect(Object.keys(fields).sort()).toEqual(['bio', 'isVerified', 'pk', 'username']);
});
