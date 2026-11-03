/**
 * The settings ops (spec §6.7, Appendix B.5): atomic and in order; scalar ops idempotent; Undo (the
 * returned inverse) restores the document; keyed list ops commute; system ops refused for the user; reset
 * never touches the seed, protection, preferences or app state; days off at most six.
 */
import fc from 'fast-check';
import type { SettingsDocV2 } from '@/settings/doc';
import { applyOps, type OpsCtx, type OpsResult } from '@/settings/ops';
import { PARAM_SPECS } from '@/settings/params';
import type { SettingsOp } from '@/shared/settings-ops';
import { docOf, resolveDoc } from '../kit/settings';

const ctx = (over: Partial<OpsCtx> = {}): OpsCtx => ({
  origin: 'user', now: 1_000, migrationPending: false,
  recommended: (doc, key) => resolveDoc(doc)[key].recommended, ...over,
});
const applied = (r: OpsResult): SettingsDocV2 => {
  if (r.kind !== 'applied') throw new Error(`refused: ${r.reason} ${r.detail}`);
  return r.doc;
};
/** The document's values, override stamps aside (an undo re-stamps them). */
const values = (d: SettingsDocV2) => ({ ...d, overrides: Object.fromEntries(Object.entries(d.overrides).map(([k, e]) => [k, e?.value])) });

const opArb: fc.Arbitrary<SettingsOp> = fc.oneof(
  fc.constantFrom<SettingsOp>(
    { op: 'intent', key: 'activity', value: 'active' }, { op: 'intent', key: 'caution', value: 'bold' },
    { op: 'intent', key: 'mutuals', value: 'keep' }, { op: 'intent', key: 'daysOff', value: [0, 6] },
    { op: 'intent', key: 'quietHours', value: { kind: 'custom', startMinute: 1320, endMinute: 360 } },
    { op: 'seed', handle: '@someone' }, { op: 'pref', key: 'practice', value: true }, { op: 'pref', key: 'boost.hours', value: 4 },
    { op: 'ui', mode: 'advanced' }, { op: 'protect-rule', rule: 'keepVerified', value: false },
    { op: 'protect-rule', rule: 'wordMatch', value: 'whole-word' }, { op: 'reset', scope: { kind: 'recommended' } },
    { op: 'reset', scope: { kind: 'section', section: 'pace' } }, { op: 'clear-override', key: 'pace.hourlyCap' },
  ),
  fc.record({ op: fc.constant('override' as const), key: fc.constantFrom('pace.hourlyCap' as const, 'unfollow.waitDays' as const), value: fc.integer({ min: 1, max: 40 }) }),
  fc.record({ op: fc.constant('protect-add' as const), entries: fc.array(fc.record({ username: fc.constantFrom('anna', 'bo.b', 'Carl_') }), { maxLength: 2 }), source: fc.constant('you' as const) }),
  fc.record({ op: fc.constant('protect-remove' as const), match: fc.record({ username: fc.constantFrom('anna', 'carl_') }) }),
  fc.record({ op: fc.constant('word-add' as const), texts: fc.array(fc.constantFrom('art', 'Café', 'travel'), { maxLength: 2 }) }),
  fc.record({ op: fc.constant('word-remove' as const), text: fc.constantFrom('art', 'cafe') }),
);

test('Undo: applying the returned inverse restores the document', () => {
  fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 6 }), (ops) => {
    const start = docOf();
    const r = applyOps(start, ops, ctx());
    if (r.kind !== 'applied') return;
    expect(values(applied(applyOps(r.doc, r.inverse, ctx())))).toEqual(values(start));
  }), { numRuns: 300 });
});

test('scalar ops are idempotent', () => {
  for (const op of [{ op: 'intent', key: 'activity', value: 'light' }, { op: 'pref', key: 'practice', value: true },
    { op: 'override', key: 'pace.hourlyCap', value: 18 }, { op: 'seed', handle: 'x' }] as SettingsOp[]) {
    const once = applied(applyOps(docOf(), [op], ctx()));
    expect(applied(applyOps(once, [op], ctx()))).toEqual(once);
  }
});

test('keyed list ops commute', () => {
  const a: SettingsOp = { op: 'protect-add', entries: [{ username: 'anna' }], source: 'you' };
  const b: SettingsOp = { op: 'protect-add', entries: [{ username: 'bob' }, { username: 'anna' }], source: 'you' };
  const w: SettingsOp = { op: 'word-add', texts: ['art', 'ART '] };
  const names = (d: SettingsDocV2) => [d.protection.accounts.map((x) => x.username).sort(), d.protection.words.map((x) => x.text.toLowerCase()).sort()];
  expect(names(applied(applyOps(docOf(), [a, b, w], ctx())))).toEqual(names(applied(applyOps(docOf(), [w, b, a], ctx()))));
  expect(names(applied(applyOps(docOf(), [a, b, w], ctx())))).toEqual([['anna', 'bob'], ['art']]);
});

test('the system ops are refused for the user and applied for the system', () => {
  for (const op of [{ op: 'protect-link', pk: '1', username: 'a', at: 1 }, { op: 'consume-bookkeeping' }] as SettingsOp[]) {
    expect(applyOps(docOf(), [op], ctx())).toMatchObject({ kind: 'refused', reason: 'invalid' });
    expect(applyOps(docOf(), [op], ctx({ origin: 'system' })).kind).toBe('applied');
  }
});

test('reset never touches the seed, protection, preferences, app state or bookkeeping', () => {
  const busy = applied(applyOps(docOf(), [
    { op: 'seed', handle: 'seedy' }, { op: 'protect-add', entries: [{ username: 'anna' }], source: 'you' },
    { op: 'word-add', texts: ['art'] }, { op: 'pref', key: 'practice', value: true }, { op: 'ui', mode: 'advanced' },
    { op: 'intent', key: 'activity', value: 'aggressive' }, { op: 'override', key: 'pace.hourlyCap', value: 10 },
  ], ctx()));
  for (const scope of [{ kind: 'recommended' }, { kind: 'section', section: 'pace' }] as const) {
    const reset = applied(applyOps(busy, [{ op: 'reset', scope }], ctx()));
    expect([reset.seed, reset.protection, reset.prefs, reset.app, reset.migration])
      .toEqual([busy.seed, busy.protection, busy.prefs, busy.app, busy.migration]);
    expect(reset.intent.activity).toBe('moderate');
    expect(reset.overrides['pace.hourlyCap']).toBeUndefined();
  }
  const other = applied(applyOps(busy, [{ op: 'reset', scope: { kind: 'section', section: 'unfollow' } }], ctx()));
  expect([other.intent.activity, other.overrides['pace.hourlyCap']?.value]).toEqual(['aggressive', 10]);
  expect(PARAM_SPECS['pace.hourlyCap'].section).toBe('pace');
});

test('seven days off is Stop, not a plan; duplicates normalize', () => {
  expect(applyOps(docOf(), [{ op: 'intent', key: 'daysOff', value: [0, 1, 2, 3, 4, 5, 6] }], ctx())).toMatchObject({ kind: 'refused', reason: 'invalid' });
  const r = applyOps(docOf(), [{ op: 'intent', key: 'daysOff', value: [6, 0, 6] }], ctx());
  expect(r.kind === 'applied' && [r.doc.intent.daysOff, r.adjustments[0]?.because]).toEqual([[0, 6], 'normalized']);
});

test('quiet hours snap to the grid; a window empty after snapping is refused', () => {
  const r = applyOps(docOf(), [{ op: 'intent', key: 'quietHours', value: { kind: 'custom', startMinute: 1330, endMinute: 365 } }], ctx());
  expect(r.kind === 'applied' && r.doc.intent.quietHours).toEqual({ kind: 'custom', startMinute: 1320, endMinute: 360 });
  expect(applyOps(docOf(), [{ op: 'intent', key: 'quietHours', value: { kind: 'custom', startMinute: 600, endMinute: 610 } }], ctx()))
    .toMatchObject({ kind: 'refused', reason: 'invalid' });
});

test('atomic: a refusal anywhere in the list applies nothing', () => {
  const r = applyOps(docOf(), [{ op: 'pref', key: 'practice', value: true }, { op: 'override', key: 'pace.dailyVolume', value: true }], ctx());
  expect(r).toMatchObject({ kind: 'refused', reason: 'invalid' });
});

test('a refused migration lets only migration and ui through; protection cannot be acknowledged', () => {
  const pending = ctx({ migrationPending: true });
  expect(applyOps(docOf(), [{ op: 'pref', key: 'practice', value: false }], pending)).toMatchObject({ reason: 'migration-pending' });
  expect(applyOps(docOf(), [{ op: 'acknowledge-protection' }], pending)).toMatchObject({ reason: 'protection-not-migrated' });
  expect(applyOps(docOf(), [{ op: 'ui', mode: 'advanced' }], pending).kind).toBe('applied');
});

test('an override records its basis; the Boost length clamps with an adjustment', () => {
  const d = applied(applyOps(docOf(), [{ op: 'override', key: 'pace.hourlyCap', value: 18 }], ctx()));
  expect(d.overrides['pace.hourlyCap']).toEqual({ value: 18, setAt: 1_000, basis: 22 });
  const r = applyOps(docOf(), [{ op: 'pref', key: 'boost.hours', value: 99 }], ctx());
  expect(r.kind === 'applied' && [r.doc.prefs.boost.hours, r.adjustments[0]?.because]).toEqual([24, 'above-safe-max']);
});

test('protect-link takes the pk for its username and follows a rename', () => {
  const sys = ctx({ origin: 'system' });
  const added = applied(applyOps(docOf(), [{ op: 'protect-add', entries: [{ username: '@Anna' }], source: 'you' }], ctx()));
  const linked = applied(applyOps(added, [{ op: 'protect-link', pk: '42', username: 'anna', at: 5 }], sys));
  expect(linked.protection.accounts[0]).toMatchObject({ pk: '42', username: 'anna', linkedAt: 5 });
  const renamed = applied(applyOps(linked, [{ op: 'protect-link', pk: '42', username: 'anna.new', at: 9 }], sys));
  expect(renamed.protection.accounts[0]).toMatchObject({ pk: '42', username: 'anna.new', formerUsernames: ['anna'], linkedAt: 9 });
  expect(applied(applyOps(renamed, [{ op: 'protect-link', pk: '42', username: 'anna.new', at: 12 }], sys))).toEqual(renamed);
});
