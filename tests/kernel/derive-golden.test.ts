/**
 * THE MIGRATION SEAM.
 *
 * `src/timing/config.ts` and `src/settings/pattern-map.ts` stopped holding
 * literals and started deriving from `src/kernel/fundamentals.ts` ×
 * `src/kernel/policy.ts`. This suite proves the swap changed nothing the app can
 * observe: every one of the 119 registry keys and every pattern-map table equals
 * the frozen copy captured before the change — key for key, exactly, no
 * tolerance — with ONE documented exception asserted on its own below.
 *
 * If this fails, either a fundamental moved (say so in an ADR) or the derivation
 * is wrong. Editing `legacy-config.snapshot.ts` to make it pass is never the fix.
 */

import { PROVENANCE } from '@/kernel/derive';
import { appliedOverrides, OVERRIDES } from '@/kernel/overrides';
import {
  type PatternSettings,
  PERSONAS,
  patternCircadianProfile,
  resolvePattern,
} from '@/settings/pattern-map';
import {
  ADAPTER,
  CIRCADIAN,
  CONNECTIVITY,
  ENGINE,
  HARNESS,
  NOISE,
  PATTERN,
  POLL,
  PRUNE,
  RECOVERY,
  RIM,
  SCHEDULER,
  SESSION,
  TAB,
  UPDATER,
} from '@/timing/config';
import { LEGACY_CONFIG_KEYS, LEGACY_SNAPSHOT } from './legacy-config.snapshot';

const DERIVED_GROUPS: Record<string, unknown> = {
  ENGINE,
  PRUNE,
  CONNECTIVITY,
  SCHEDULER,
  ADAPTER,
  TAB,
  RECOVERY,
  RIM,
  NOISE,
  POLL,
  HARNESS,
  CIRCADIAN,
  SESSION,
  PATTERN,
  UPDATER,
};

/** The legacy registry with the one deliberate change applied. */
const EXPECTED_GROUPS = {
  ...LEGACY_SNAPSHOT.groups,
  RECOVERY: {
    ...LEGACY_SNAPSHOT.groups.RECOVERY,
    PRUNE_COOLDOWN_AFTER_RATE_HALT_MS:
      OVERRIDES['RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS'].value,
  },
};

const KNOB_LEVELS = {
  activityLevel: ['minimal', 'light', 'moderate', 'active', 'aggressive'],
  consistency: ['clockwork', 'natural', 'erratic'],
  rhythm: ['trickle', 'sessions', 'bursts'],
  dayShape: ['morning', 'balanced', 'evening', 'nightowl', 'business'],
  weeklyShape: ['uniform', 'weekdays', 'weekends', 'realistic'],
  caution: ['cautious', 'standard', 'bold'],
  cleanup: ['off', 'trickle', 'steady', 'deep'],
  patience: ['quick', 'normal', 'patient'],
} as const;

describe('golden table — the derived registry equals what the app shipped', () => {
  test('every group matches key-for-key (one documented exception applied)', () => {
    expect(DERIVED_GROUPS).toEqual(EXPECTED_GROUPS);
  });

  test('the snapshot really is the whole registry: 119 leaf keys, 15 groups', () => {
    expect(LEGACY_CONFIG_KEYS).toHaveLength(119);
    expect(Object.keys(LEGACY_SNAPSHOT.groups)).toHaveLength(15);
    const derivedKeys = Object.entries(DERIVED_GROUPS).flatMap(([g, keys]) =>
      Object.keys(keys as Record<string, unknown>).map((k) => `${g}.${k}`),
    );
    expect(derivedKeys.sort()).toEqual([...LEGACY_CONFIG_KEYS].sort());
  });

  test('THE ONE BEHAVIOUR CHANGE: the prune cool-down rises from 2 h to the p50 wall', () => {
    expect(LEGACY_SNAPSHOT.groups.RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS).toBe(2 * 3_600_000);
    expect(RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS).toBe(3 * 3_600_000);
    // …and it is the ONLY key whose value moved.
    const moved = Object.entries(DERIVED_GROUPS).flatMap(([g, keys]) =>
      Object.entries(keys as Record<string, unknown>)
        .filter(
          ([k, v]) =>
            JSON.stringify(v) !==
            JSON.stringify(
              (LEGACY_SNAPSHOT.groups as Record<string, Record<string, unknown>>)[g][k],
            ),
        )
        .map(([k]) => `${g}.${k}`),
    );
    expect(moved).toEqual(['RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS']);
  });

  test('every persona resolves to exactly its historical numbers', () => {
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      expect({ id, ...resolvePattern(PERSONAS[id]) }).toEqual({
        id,
        ...(LEGACY_SNAPSHOT.personas as Record<string, Record<string, unknown>>)[id],
      });
    }
  });

  test('the persona BUNDLES (which knobs each persona sets) are unchanged', () => {
    expect(PERSONAS).toEqual(LEGACY_SNAPSHOT.personaBundles);
  });

  test('the full ordinal grid — every level of every knob — is unchanged', () => {
    for (const [knob, levels] of Object.entries(KNOB_LEVELS)) {
      for (const level of levels) {
        const key = `${knob}=${level}`;
        const resolved = resolvePattern({ ...PERSONAS.balanced, [knob]: level } as PatternSettings);
        expect({ key, ...resolved }).toEqual({
          key,
          ...(LEGACY_SNAPSHOT.grid as Record<string, Record<string, unknown>>)[key],
        });
      }
    }
  });

  test('every circadian profile (5 day shapes × 4 week shapes) is unchanged', () => {
    for (const level of KNOB_LEVELS.dayShape) {
      const key = `dayShape=${level}`;
      const p = patternCircadianProfile({ ...PERSONAS.balanced, dayShape: level }, 0);
      expect({ key, ...p }).toEqual({ key, ...(LEGACY_SNAPSHOT.profiles as Record<string, Record<string, unknown>>)[key] });
    }
    for (const level of KNOB_LEVELS.weeklyShape) {
      const key = `weeklyShape=${level}`;
      const p = patternCircadianProfile({ ...PERSONAS.balanced, weeklyShape: level }, 0);
      expect({ key, ...p }).toEqual({ key, ...(LEGACY_SNAPSHOT.profiles as Record<string, Record<string, unknown>>)[key] });
    }
  });
});

describe('override discipline', () => {
  test('every applied override actually differs from its derivation, or says why not', () => {
    for (const o of appliedOverrides()) {
      expect(o.reason.length).toBeGreaterThan(40);
      if (o.value === o.derived) {
        // The only same-value entry is the deliberate change.
        expect(o.change).toBe(true);
      }
    }
  });

  test('exactly one override is a deliberate behaviour change', () => {
    expect(appliedOverrides().filter((o) => o.change === true).map((o) => o.path)).toEqual([
      'RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS',
    ]);
  });

  test('advisory overrides are recorded but never applied to the registry', () => {
    // ACTIONS_FAILING_HALT lives in the engine; the derivation says 7, we ship 8.
    expect(OVERRIDES['ENGINE.ACTIONS_FAILING_HALT'].advisory).toBe(true);
    expect(appliedOverrides().map((o) => o.path)).not.toContain('ENGINE.ACTIONS_FAILING_HALT');
  });

  test('PROVENANCE names a tier for every registry key, and nothing else', () => {
    expect(Object.keys(PROVENANCE).sort()).toEqual([...LEGACY_CONFIG_KEYS].sort());
    const tally = Object.values(PROVENANCE).reduce<Record<string, number>>((acc, tier) => {
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    // The accounting reported in docs/adr/0605: 49 derive, 41 are policy bounds,
    // 18 are pinned overrides, 11 are dev-harness values that never derive.
    expect(tally).toEqual({ derived: 49, policy: 41, override: 18, harness: 11 });
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(119);
  });
});
