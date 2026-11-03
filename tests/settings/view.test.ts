/**
 * The Settings view (spec §6.4, §6.9): deterministic for a fixed document; rows hidden while their
 * capability is off; the Easy card match (custom once a pace number is overridden); card numbers from the
 * day law at the user's own consistency; the typical day; notices from the migration, minus dismissed ones.
 */
import { ACTIVITY } from '@/kernel';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { SettingsDocV2 } from '@/settings/doc';
import { effectiveFrom } from '@/settings/effective';
import { buildView } from '@/settings/view';
import type { SettingsCapabilities } from '@/shared/settings-view';
import { docOf, FAKE_PLAN_MATH, overridesOf, resolveDoc } from '../kit/settings';

const OFF: SettingsCapabilities = { plan: false, tempo: false, boost: false, protectionEverywhere: false };
const view = (doc: SettingsDocV2, capabilities = OFF) => {
  const resolved = resolveDoc(doc, capabilities.plan);
  return buildView({ doc, health: { kind: 'ok' }, capabilities, resolved, effective: effectiveFrom(doc, resolved), math: FAKE_PLAN_MATH, week: null });
};

test('deterministic for a fixed document', () => {
  expect(view(docOf())).toEqual(view(docOf()));
});

test('rows wait for their capability: tempo rows for tempo, the gap rows for the plan', () => {
  const keys = (c: SettingsCapabilities) => view(docOf(), c).params.map((p) => p.key);
  expect(keys(OFF).some((k) => k.startsWith('tempo.') || k.startsWith('sessions.gap'))).toBe(false);
  expect(keys({ ...OFF, tempo: true }).some((k) => k.startsWith('tempo.'))).toBe(true);
  expect(keys({ ...OFF, plan: true })).toEqual(expect.arrayContaining(['sessions.gapTypical', 'sessions.gapMinimum']));
});

test('without the plan a re-plan row applies from the next day; with it, it re-plans today', () => {
  const at = (c: SettingsCapabilities) => view(docOf(), c).params.find((p) => p.key === 'pace.dailyVolume')?.applies;
  expect([at(OFF), at({ ...OFF, plan: true })]).toEqual(['next-day', 'replan']);
});

test('the Easy card matches the intent, and turns custom once a pace number is overridden', () => {
  expect(view(docOf()).easy.pace).toBe('balanced');
  expect(view(docOf({ intent: { ...docOf().intent, activity: 'light', caution: 'cautious' } })).easy.pace).toBe('gentle');
  expect(view(docOf({ overrides: overridesOf({ 'pace.hourlyCap': 18 }) })).easy.pace).toBe('custom');
  expect(view(docOf({ overrides: overridesOf({ 'audience.followerRange': { min: 1, max: 9 } }) })).easy.size).toBe('custom');
});

test('card numbers come from the day law at the user’s consistency; the typical day from the effective target', () => {
  const v = view(docOf());
  const balanced = v.options.paceCards.find((c) => c.id === 'balanced');
  expect(balanced?.perDay).toEqual(FAKE_PLAN_MATH.dayLaw({ operatingRate: ACTIVITY.moderate, dayVariationPct: 28, restDayPct: 8 }));
  expect(v.typical.automaticMax).toBe(48);
  expect(v.typical.shareOfLowWall).toBeCloseTo(0.48, 10);
  expect(v.typical.risk).toBe('standard');
  expect(view(docOf({ intent: { ...docOf().intent, activity: 'aggressive' } })).typical.risk).toBe('at-limit');
});

test('the options cover every choice, with the Boost lengths of the policy', () => {
  const o = view(docOf()).options;
  expect(Object.keys(o.activity)).toHaveLength(5);
  expect(o.schedule).toHaveLength(5);
  expect(o.boostHours.choices).toEqual([...SETTINGS_POLICY.BOOST.CHOICES]);
  expect(o.focus.likely).toEqual(SETTINGS_POLICY.RATIO_CURVE);
});

test('notices follow the migration notes, minus the dismissed ones; protection under review is never dismissible', () => {
  const migrated = docOf({
    protectionState: 'needs-review',
    migration: { at: 1, fromV1: null, bookkeeping: null, notes: [{ kind: 'verified-kept' }, { kind: 'bio-words-widened', words: 3 }] },
  });
  const ids = (d: SettingsDocV2) => view(d).notices.map((n) => n.id);
  expect(ids(migrated)).toEqual(['protection:needs-review', 'migration:verified-kept', 'migration:bio-words-widened']);
  expect(view(migrated).notices[2].data).toEqual({ words: 3 });
  const dismissed = { ...migrated, app: { ...migrated.app, dismissedNotices: ['migration:verified-kept', 'protection:needs-review'] } };
  expect(ids(dismissed)).toEqual(['protection:needs-review', 'migration:bio-words-widened']);
});

test('the summary says when people who follow back are kept; reads count per plan-day', () => {
  const kept = view(docOf({ intent: { ...docOf().intent, mutuals: 'keep' } }));
  expect(kept.effective.holdDays).toBeNull();
  expect(kept.params.find((p) => p.key === 'unfollow.holdDays')?.inactive).toBe('mutuals-kept');
  expect(kept.reads).toMatchObject({ window: 'plan-day', backstop: 'trailing-24h' });
});
