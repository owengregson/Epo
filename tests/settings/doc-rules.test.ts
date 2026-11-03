/**
 * Coercion of the v2 document (ADR 0103 style): it never throws, repairs every
 * field to the nearest safe value, and counts the garbage it drops so the service
 * can put protection under review.
 */

import fc from 'fast-check';
import { DEFAULT_DOC } from '@/settings/doc';
import { coerceDoc } from '@/settings/doc-rules';

test('a well-formed document round-trips with nothing dropped', () => {
  expect(coerceDoc(DEFAULT_DOC)).toEqual({ value: DEFAULT_DOC, dropped: 0 });
  const doc = {
    ...DEFAULT_DOC, rev: 7, seed: 'studio',
    overrides: { 'pace.hourlyCap': { value: 18, setAt: 5, basis: 22 } },
    protection: {
      accounts: [{ pk: '9', username: 'jane', linkedAt: 4, formerUsernames: ['jan'], addedAt: 3, source: 'you', valid: true }],
      words: [{ text: 'shop', addedAt: 2 }], wordMatch: 'whole-word', keepVerified: false,
    },
  };
  expect(coerceDoc(doc)).toEqual({ value: doc, dropped: 0 });
});

test('coercion never throws, whatever arrives', () => {
  fc.assert(fc.property(fc.anything(), (raw) => {
    const c = coerceDoc(raw);
    expect(c.value.v).toBe(2);
    expect(c.dropped).toBeGreaterThanOrEqual(0);
  }), { numRuns: 300 });
});

test('garbage is dropped and counted, field by field', () => {
  const c = coerceDoc({
    ...DEFAULT_DOC,
    intent: { ...DEFAULT_DOC.intent, activity: 'turbo', daysOff: [1, 1, 9, 'x'] },
    overrides: { 'pace.hourlyCap': { value: 18, setAt: 5, basis: 22 }, 'nope.key': { value: 1, setAt: 1, basis: 1 },
      'pace.dailyVolume': { value: 'many', setAt: 1, basis: 50 } },
    protection: { ...DEFAULT_DOC.protection, accounts: [{ username: 'x' }, null], words: [{ text: 'ok', addedAt: 1 }, 5] },
    prefs: { practice: 'yes', acceptRequests: true, boost: { hours: 99, acceptRequests: true } },
  });
  expect(c.value.intent.activity).toBe('moderate');
  expect(c.value.intent.daysOff).toEqual([1]);
  expect(Object.keys(c.value.overrides)).toEqual(['pace.hourlyCap']);
  expect(c.value.protection.accounts).toEqual([]);
  expect(c.value.protection.words).toEqual([{ text: 'ok', addedAt: 1 }]);
  expect(c.value.prefs.practice).toBe(false);
  expect(c.value.prefs.boost.hours).toBe(24);
  // activity 1 + daysOff (9, 'x', the duplicate) 3 + overrides 2 + accounts 2 + words 1 + practice 1
  expect(c.dropped).toBe(10);
});

test('a tempo override is a parameter like any other; the two keys other parameters set are not', () => {
  const tempo = { 'tempo.walk.page': { value: 1.5, setAt: 5, basis: 1 }, 'tempo.check.spacing': { value: 2, setAt: 5, basis: 1 } };
  const c = coerceDoc({ ...DEFAULT_DOC, overrides: tempo });
  expect(c.value.overrides).toEqual({ 'tempo.walk.page': { value: 1.5, setAt: 5, basis: 1 } });
  expect(c.dropped).toBe(1);
});

test('an unknown protection state reads as needs-review, never ready', () => {
  expect(coerceDoc({ ...DEFAULT_DOC, protectionState: 'fine' }).value.protectionState).toBe('needs-review');
  expect(coerceDoc({ ...DEFAULT_DOC, protectionState: undefined }).value.protectionState).toBe('needs-review');
});

test('quiet hours snap to the 30-minute grid; an empty window falls back; too many days off fall back', () => {
  const custom = (startMinute: number, endMinute: number) =>
    coerceDoc({ ...DEFAULT_DOC, intent: { ...DEFAULT_DOC.intent, quietHours: { kind: 'custom', startMinute, endMinute } } });
  expect(custom(1381, 361).value.intent.quietHours).toEqual({ kind: 'custom', startMinute: 1380, endMinute: 360 });
  expect(custom(600, 610)).toMatchObject({ value: { intent: { quietHours: { kind: 'derived' } } }, dropped: 1 });
  const all = coerceDoc({ ...DEFAULT_DOC, intent: { ...DEFAULT_DOC.intent, daysOff: [0, 1, 2, 3, 4, 5, 6] } });
  expect(all.value.intent.daysOff).toEqual([]);
  expect(all.dropped).toBe(1);
});
