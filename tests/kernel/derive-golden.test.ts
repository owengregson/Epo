/**
 * THE MIGRATION SEAM (ADR 0605, rewritten by ADR 0607): the registry, the grid, the personas and the
 * profiles equal the frozen snapshot minus the RETIRED keys, with every CHANGED value moved — key for
 * key, no tolerance. Editing `legacy-config.snapshot.ts` to make this pass is never the fix.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS_FAILING_HALT } from '@/engine/engine';
import { PRUNE_CONSECUTIVE_FAIL_HALT } from '@/engine/prune-engine';
import { coldFailingThreshold, PROVENANCE, pollEveryFrom, pruneFailingThreshold } from '@/kernel/derive';
import { appliedOverrides, OVERRIDES } from '@/kernel/overrides';
import { POLICY } from '@/kernel/policy';
import { CHANGED, RETIRED } from '@/kernel/registry-changes';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { NOT_TEMPO } from '@/kernel/tempo';
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

type Table = Record<string, Record<string, unknown>>;
type Section = 'groups' | 'personas' | 'grid' | 'profiles';

const DERIVED_GROUPS: Table = {
  ENGINE, PRUNE, CONNECTIVITY, SCHEDULER, ADAPTER, TAB, RECOVERY, RIM, NOISE, POLL, HARNESS, CIRCADIAN,
  SESSION, PATTERN, UPDATER,
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

/** What each snapshot section derives to today, keyed exactly as the snapshot keys it. */
function live(section: Section): Table {
  if (section === 'groups') return DERIVED_GROUPS;
  const out: Table = {};
  if (section === 'personas') {
    for (const id of Object.keys(PERSONAS) as Array<keyof typeof PERSONAS>) {
      out[id] = { ...resolvePattern(PERSONAS[id]) };
    }
    return out;
  }
  for (const [knob, levels] of Object.entries(KNOB_LEVELS)) {
    for (const level of levels) {
      const pattern = { ...PERSONAS.balanced, [knob]: level } as PatternSettings;
      if (section === 'grid') out[`${knob}=${level}`] = { ...resolvePattern(pattern) };
      else if (knob === 'dayShape' || knob === 'weeklyShape') {
        out[`${knob}=${level}`] = { ...patternCircadianProfile(pattern, 0) };
      }
    }
  }
  return out;
}

/** The snapshot section as the ledgers say it must derive now: `snapshot − RETIRED ⊕ CHANGED`. */
function expected(section: Section): Table {
  const out: Table = {};
  for (const [id, row] of Object.entries(LEGACY_SNAPSHOT[section] as Table)) {
    out[id] = Object.fromEntries(
      Object.entries(row).filter(([key]) => !(section === 'groups' && `${id}.${key}` in RETIRED)),
    );
  }
  for (const change of CHANGED) {
    const [at, id, field] = change.path.split('.');
    if (at === section) out[id][field] = change.to;
  }
  return out;
}

/** Every leaf whose live value differs from the frozen snapshot, as `{ path, from, to }`, sorted. */
function movedLeaves(): Array<{ path: string; from: unknown; to: unknown }> {
  const moved: Array<{ path: string; from: unknown; to: unknown }> = [];
  for (const section of ['groups', 'personas', 'grid', 'profiles'] as const) {
    for (const [id, row] of Object.entries(live(section))) {
      for (const [field, value] of Object.entries(row)) {
        const from = (LEGACY_SNAPSHOT[section] as Table)[id]?.[field];
        if (JSON.stringify(value) !== JSON.stringify(from)) moved.push({ path: `${section}.${id}.${field}`, from, to: value });
      }
    }
  }
  return moved.sort((a, b) => a.path.localeCompare(b.path));
}

describe('golden table — what the app derives is the snapshot minus RETIRED, plus CHANGED', () => {
  test('every registry group matches key for key', () => {
    expect(DERIVED_GROUPS).toEqual(expected('groups'));
  });

  test('the snapshot is still the whole legacy registry: 119 leaf keys in 15 groups', () => {
    expect(LEGACY_CONFIG_KEYS).toHaveLength(119);
    expect(Object.keys(LEGACY_SNAPSHOT.groups)).toHaveLength(15);
  });

  test('the live registry is exactly the snapshot keys less the retired keys', () => {
    const liveKeys = Object.entries(DERIVED_GROUPS).flatMap(([g, keys]) => Object.keys(keys).map((k) => `${g}.${k}`));
    expect(Object.keys(RETIRED)).toHaveLength(20);
    expect(liveKeys.sort()).toEqual(LEGACY_CONFIG_KEYS.filter((k) => !(k in RETIRED)).sort());
    expect(liveKeys).toHaveLength(99);
  });

  test('every persona resolves to its ledgered numbers', () => {
    expect(live('personas')).toEqual(expected('personas'));
  });

  test('the persona BUNDLES (which knobs each persona sets) are unchanged', () => {
    expect(PERSONAS).toEqual(LEGACY_SNAPSHOT.personaBundles);
  });

  test('the full ordinal grid — every level of every knob — is its ledgered numbers', () => {
    for (const [key, row] of Object.entries(live('grid'))) expect({ key, ...row }).toEqual({ key, ...expected('grid')[key] });
  });

  test('every circadian profile (5 day shapes × 4 week shapes) is its ledgered shape', () => {
    expect(live('profiles')).toEqual(expected('profiles'));
  });

  test('the deliberate changes are exactly the CHANGED ledger: nothing else moved', () => {
    const ledger = CHANGED.map(({ path, from, to }) => ({ path, from, to }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(movedLeaves()).toEqual(ledger);
    for (const change of CHANGED) expect(change.adr).toMatch(/^0\d{3}$/);
  });

  test('the prune cool-down row is the override that carries the deliberate change', () => {
    const row = CHANGED.find((c) => c.path === 'groups.RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS');
    expect(row).toEqual({ path: 'groups.RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS', from: 2 * 3_600_000,
      to: OVERRIDES['RECOVERY.PRUNE_COOLDOWN_AFTER_RATE_HALT_MS'].value, adr: '0606' });
  });
});

describe('the RETIRED ledger', () => {
  test('every retired key was a legacy registry key and names its replacement', () => {
    for (const [key, retired] of Object.entries(RETIRED)) {
      expect({ key, legacy: LEGACY_CONFIG_KEYS.includes(key) }).toEqual({ key, legacy: true });
      expect(retired.adr).toBe('0607');
      expect(retired.replacedBy.length).toBeGreaterThan(10);
      expect(retired.reason.length).toBeGreaterThan(20);
    }
  });

  test('a retired key leaves no provenance row, no override and no tempo note behind', () => {
    for (const key of Object.keys(RETIRED)) {
      expect({ key, provenance: key in PROVENANCE, override: key in OVERRIDES, note: key in NOT_TEMPO })
        .toEqual({ key, provenance: false, override: false, note: false });
    }
  });

  test('no group, grid point, persona or profile CHANGED a retired key', () => {
    for (const change of CHANGED) expect(change.path.slice('groups.'.length) in RETIRED).toBe(false);
  });
});

describe('the derivations hold no unnamed literal (spec §17.3)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'kernel', 'derive.ts'), 'utf8');

  test('the 10–90 z is the POLICY dial the typical-day band shares', () => {
    expect(POLICY.DRAW_DECILE_Z).toBe(SETTINGS_POLICY.TYPICAL_DAY_Z);
    expect(source).not.toMatch(/1\.2816/);
  });

  test('the poll divisor, its band and the four derivation factors are named, not inline', () => {
    for (const inline of [/p50Ms \/ 4\b/, /100, 1_000\)/, /GAP_CAP_MS \/ 8\b/, /frameMs \* 30\b/, /p90 \* 2\b/,
      /perceptionMs \* 3\b/, /DESYNC_WIDTH_MS \/ 2\b/]) expect(source).not.toMatch(inline);
  });

  test('a poll is a quarter of its p50, inside [100 ms, 1 s], on the 50 ms grid', () => {
    expect([pollEveryFrom(40), pollEveryFrom(1_000), pollEveryFrom(1_100), pollEveryFrom(9_000)])
      .toEqual([100, 250, 300, 1_000]);
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

  test('the cold breaker applies its derivation (7): no advisory entry remains', () => {
    expect('ENGINE.ACTIONS_FAILING_HALT' in OVERRIDES).toBe(false);
    expect(appliedOverrides()).toHaveLength(Object.keys(OVERRIDES).length);
    expect([coldFailingThreshold(), ACTIONS_FAILING_HALT]).toEqual([7, 7]);
  });

  test("a cleanup run's fail halt is an applied override of the cold derivation (4, derived 7)", () => {
    expect(OVERRIDES['PRUNE.CONSECUTIVE_FAIL_HALT']).toMatchObject({ value: 4, derived: coldFailingThreshold() });
    expect([pruneFailingThreshold(), PRUNE_CONSECUTIVE_FAIL_HALT]).toEqual([4, 4]);
  });

  test('PROVENANCE names a tier for every live registry key, and nothing else', () => {
    expect(Object.keys(PROVENANCE).sort()).toEqual(LEGACY_CONFIG_KEYS.filter((k) => !(k in RETIRED)).sort());
    const tally = Object.values(PROVENANCE).reduce<Record<string, number>>((acc, tier) => {
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    // The reviewed accounting (ADR 0607): 40 derive, 34 are policy bounds, 16 are pinned overrides,
    // 9 are dev-harness values that never derive.
    expect(tally).toEqual({ derived: 40, policy: 34, override: 16, harness: 9 });
    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(99);
  });
});
