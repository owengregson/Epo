/**
 * The migration's effective-equality post-condition (spec §6.10, law L-MIG): with the resolver given, the
 * migrated document's effective record equals the v1-sanitized object on every retained knob; every default
 * persona still migrates with zero overrides; a hand-set volume keeps the ceiling it ran with.
 */
import { migrationBasis } from '@/settings/basis';
import type { SettingsDocV2 } from '@/settings/doc';
import { effectiveFrom } from '@/settings/effective';
import { migrateV1 } from '@/settings/migrate-v1';
import { PERSONAS } from '@/settings/pattern-map';
import { resolveParams } from '@/settings/resolve';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import { FAKE_PLAN_MATH } from '../kit/settings';

const resolve = (doc: SettingsDocV2) =>
  resolveParams({ intent: doc.intent, overrides: doc.overrides, plan: false, math: FAKE_PLAN_MATH });
const migrate = (v1: object) =>
  migrateV1(JSON.stringify(v1), { now: 1, legacyAccountPk: null, mtimeMs: 1, basis: migrationBasis(FAKE_PLAN_MATH), resolve });

test('the default file and every default persona migrate with zero overrides, the post-condition on', () => {
  for (const persona of ['custom', ...Object.keys(PERSONAS)]) {
    const out = migrate({ ...DEFAULT_SETTINGS, persona });
    expect({ persona, kind: out.kind, overrides: out.kind === 'migrated' ? out.doc.overrides : null })
      .toEqual({ persona, kind: 'migrated', overrides: {} });
  }
});

test('a hand-set volume keeps the ceiling and buffer it ran with (v2 would otherwise chain them upward)', () => {
  const { persona: _p, pattern: _q, ...numbers } = DEFAULT_SETTINGS;
  const out = migrate({ ...numbers, dailyOperatingRate: 61 });
  if (out.kind !== 'migrated') throw new Error(out.reasons.join());
  const e = effectiveFrom(out.doc, resolve(out.doc));
  expect([e.dailyOperatingRate, e.dailyHardCeiling, e.dailyPlanSize]).toEqual([61, 65, 60]);
});

test('a value the new bounds clamp is noted, never a refusal', () => {
  const { persona: _p, pattern: _q, ...numbers } = DEFAULT_SETTINGS;
  const out = migrate({ ...numbers, hourlyVelocityCap: 40 });
  expect(out.kind).toBe('migrated');
  expect(out.kind === 'migrated' && out.doc.migration?.notes).toEqual(
    expect.arrayContaining([{ kind: 'value-clamped', key: 'pace.hourlyCap', from: 40, to: 30 }]));
});
