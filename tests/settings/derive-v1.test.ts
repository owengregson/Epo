/**
 * `V1_DERIVED` is the frozen v1 derivation: it equals the snapshot's 30 grid points
 * and personas exactly (the live kernel derivation may move later; this table may not).
 */

import { gapFloorSeconds } from '@/kernel/derive';
import { type PatternSettings, PERSONAS } from '@/settings/pattern-map';
import { v1Derived } from '@/settings/v1/derive-v1';
import { DEFAULT_SETTINGS, sanitizeSettings } from '@/settings/v1/settings-v1';
import { LEGACY_SNAPSHOT } from '../kernel/legacy-config.snapshot';

const BALANCED = PERSONAS.balanced;

test('the 30 grid points of the legacy snapshot', () => {
  const grid = (LEGACY_SNAPSHOT as unknown as { grid: Record<string, unknown> }).grid;
  expect(Object.keys(grid)).toHaveLength(30);
  for (const [point, expected] of Object.entries(grid)) {
    const [knob, value] = point.split('=') as [keyof PatternSettings, string];
    expect({ point, derived: v1Derived({ ...BALANCED, [knob]: value }) }).toEqual({ point, derived: expected });
  }
});

test('the personas of the legacy snapshot', () => {
  const personas = (LEGACY_SNAPSHOT as unknown as { personas: Record<string, unknown> }).personas;
  for (const [id, pattern] of Object.entries(PERSONAS)) expect(v1Derived(pattern)).toEqual(personas[id]);
});

test('v1 sanitizing keeps the frozen cautious floor when the live floor rises', () => {
  expect(gapFloorSeconds('cautious')).toBe(70);
  for (const persona of ['casual', 'custom'] as const) {
    const legacy = sanitizeSettings({ ...DEFAULT_SETTINGS, persona, pattern: PERSONAS.casual });
    expect(legacy.gapFloorSeconds).toBe(60);
    expect(legacy).toMatchObject(v1Derived(PERSONAS.casual));
  }
});
