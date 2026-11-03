/**
 * The production plan math against the plan core (spec §5.4, §5.10): at every grid point the gap rows,
 * the day law, its maximum and the retry limit are the plan's own numbers for the same effective
 * settings; Easy's "most days" never passes `automaticDayMax(P0)`; every default persona migrates clean.
 */

import { gridPoints } from '@/kernel/derive-envelope';
import { retryLimit } from '@/kernel/derive-lifecycle';
import { effectiveGapAtPace1 } from '@/kernel/plan/gap';
import { automaticDayMax, dayLawQuantiles } from '@/kernel/plan/volume';
import { migrationBasis } from '@/settings/basis';
import type { SettingsDocV2 } from '@/settings/doc';
import { effectiveFrom } from '@/settings/effective';
import { migrateV1 } from '@/settings/migrate-v1';
import { PERSONAS } from '@/settings/pattern-map';
import { toPlanIntent } from '@/settings/plan-intent';
import { KERNEL_PLAN_MATH as M } from '@/settings/plan-math';
import { numberOf, resolveParams } from '@/settings/resolve';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { buildView } from '@/settings/view';
import { docOf, intentOf, overridesOf } from '../kit/settings';

const resolve = (doc: SettingsDocV2, plan = true) =>
  resolveParams({ intent: doc.intent, overrides: doc.overrides, plan, math: M });

describe.each(gridPoints().map((p) => [`${p.activityLevel}/${p.caution}/${p.rhythm}/${p.consistency}`, p] as const))('at %s', (_name, p) => {
  const doc = docOf({ intent: intentOf(p) });
  const r = resolve(doc);
  const e = effectiveFrom(doc, r);
  const intent = toPlanIntent(e);

  test('the gap rows are the plan\'s own gap at pace 1', () => {
    const plan = effectiveGapAtPace1(intent);
    expect(numberOf(r, 'sessions.gapTypical')).toBe(Math.round(plan.typicalMs / 1000));
    // The minimum is solved for the typical row in whole seconds: at most a second from the plan's.
    expect(Math.abs(numberOf(r, 'sessions.gapMinimum') - plan.minimumMs / 1000)).toBeLessThanOrEqual(1);
  });

  test('the day law, its maximum and the retry limit are the plan\'s', () => {
    const q = dayLawQuantiles(intent);
    expect(M.dayLaw({ operatingRate: e.dailyOperatingRate, dayVariationPct: e.dailyVolumeVariancePct, restDayPct: e.restDayChancePct }))
      .toEqual({ low: q.p10, typical: q.median, high: q.p90 });
    expect(M.automaticDayMax(e.dailyOperatingRate)).toBe(automaticDayMax(e.dailyOperatingRate));
    expect(numberOf(r, 'unfollow.attempts')).toBe(retryLimit());
  });

  test('most days stay ordered and never pass the largest automatic day, on every card', () => {
    const view = buildView({ doc, health: { kind: 'ok' }, capabilities: { plan: true, tempo: true, boost: true, protectionEverywhere: true },
      resolved: r, effective: e, math: M, week: null });
    for (const card of [...view.options.paceCards, ...Object.values(view.options.activity), view.typical]) {
      const { low, typical, high } = card.perDay;
      expect(low).toBeLessThanOrEqual(typical);
      expect(typical).toBeLessThanOrEqual(high);
    }
    expect(view.typical.perDay.high).toBeLessThanOrEqual(automaticDayMax(e.dailyOperatingRate));
  });
});

test('a slower typical pause lengthens the plan\'s floor with it, and the rows follow the plan', () => {
  const base = docOf({ intent: intentOf(gridPoints()[0]) });
  const rec = numberOf(resolve(base), 'sessions.gapTypical');
  const doc = docOf({ intent: base.intent, overrides: overridesOf({ 'sessions.gapTypical': rec * 2 }) });
  const r = resolve(doc);
  const plan = effectiveGapAtPace1(toPlanIntent(effectiveFrom(doc, r)));
  expect(numberOf(r, 'sessions.gapTypical')).toBe(plan.typicalMs / 1000);
  expect(Math.abs(numberOf(r, 'sessions.gapMinimum') - plan.minimumMs / 1000)).toBeLessThanOrEqual(1);
  expect(numberOf(r, 'sessions.gapMinimum')).toBeGreaterThan(numberOf(resolve(base), 'sessions.gapMinimum'));
});

test('with the production basis, the default file and every default persona migrate with zero overrides', () => {
  const basis = migrationBasis(M);
  for (const persona of ['custom', ...Object.keys(PERSONAS)]) {
    const out = migrateV1(JSON.stringify({ ...DEFAULT_SETTINGS, persona }),
      { now: 1, legacyAccountPk: null, mtimeMs: 1, basis, resolve: (d) => resolve(d, false) });
    expect({ persona, kind: out.kind, overrides: out.kind === 'migrated' ? out.doc.overrides : null })
      .toEqual({ persona, kind: 'migrated', overrides: {} });
  }
});
