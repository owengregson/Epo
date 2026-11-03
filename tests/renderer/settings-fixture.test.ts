/**
 * The gallery's Settings view is a frozen snapshot of what main builds (spec §6.9): this test rebuilds it from
 * the fixture document with the kernel's plan math and fails when the two drift. Regenerate with
 * `EPO_WRITE_SETTINGS_FIXTURE=1 npx jest tests/renderer/settings-fixture` after a deliberate view change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GALLERY_CAPABILITIES, GALLERY_DOC_PARTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import { DEFAULT_DOC, type SettingsDocV2 } from '@/settings/doc';
import { effectiveFrom } from '@/settings/effective';
import { KERNEL_PLAN_MATH } from '@/settings/plan-math';
import { resolveParams } from '@/settings/resolve';
import { buildView } from '@/settings/view';
import type { SettingsView } from '@/shared/settings-view';

const FIXTURE = path.join(__dirname, '../../src/renderer/gallery/settings-fixture.json');

/** The view main serves for the fixture document: every capability on, no week (plan-days are local-time). */
function buildSettingsView(doc: SettingsDocV2): SettingsView {
  const resolved = resolveParams({
    intent: doc.intent, overrides: doc.overrides, plan: GALLERY_CAPABILITIES.plan, math: KERNEL_PLAN_MATH,
  });
  const effective = effectiveFrom(doc, resolved);
  return buildView({
    doc, health: { kind: 'ok' }, capabilities: GALLERY_CAPABILITIES, resolved, effective, math: KERNEL_PLAN_MATH, week: null,
  });
}

const doc: SettingsDocV2 = { ...DEFAULT_DOC, ...GALLERY_DOC_PARTS, app: { ...DEFAULT_DOC.app, ...GALLERY_DOC_PARTS.app } };

describe('the gallery Settings fixture', () => {
  const built = buildSettingsView(doc);
  if (process.env.EPO_WRITE_SETTINGS_FIXTURE === '1') fs.writeFileSync(FIXTURE, `${JSON.stringify(built, null, 1)}\n`);

  it('equals the view main builds from the fixture document (regenerate on a deliberate change)', () => {
    expect(GALLERY_SETTINGS_VIEW).toEqual(JSON.parse(JSON.stringify(built)));
  });

  it('shows every capability and every Advanced row the stage renders', () => {
    expect(GALLERY_SETTINGS_VIEW.capabilities).toEqual({ plan: true, tempo: true, boost: true, protectionEverywhere: true });
    expect(GALLERY_SETTINGS_VIEW.params.some((p) => p.key === 'tempo.dwell.visit')).toBe(true);
    expect(GALLERY_SETTINGS_VIEW.protection.accounts.length).toBeGreaterThan(0);
  });
});
