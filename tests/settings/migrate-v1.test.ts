/**
 * The pure v1 → v2 migration (spec §6.10): golden fixtures for the default file,
 * every persona (cautious included), custom and numbers-only files, messy lists,
 * the schedule × cleanup mapping, deep, an inert refill threshold, hand-edited
 * active hours, legacy pacing, faster values (a faster pruneScan included) and a
 * corrupt file; and law L-MIG: protection monotone, no list shrinks, idempotent,
 * every default persona → zero overrides.
 */

import fc from 'fast-check';
import { bioMatchesFilter } from '@/engine/prune-bio-filter';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import { referenceTempoSource } from '@/kernel/tempo';
import { MS_PER_SECOND } from '@/kernel/units';
import { effectiveFromV1 } from '@/settings/effective';
import { type MigrationBasis, type MigrationOutcome, migrateV1 } from '@/settings/migrate-v1';
import { PERSONAS, type PersonaId } from '@/settings/pattern-map';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import type { Settings } from '@/settings/v1/settings-v1-types';
import { isPruneWhitelisted, pruneWhitelistSet } from '@/shared/prune-whitelist';
import { compileProtection, foldText, normalizeHandle, protectionVerdict } from '@/shared/unfollow-protection';

const NOW = 1_700_000_000_000;
const GAP: Record<string, readonly [number, number]> = { cautious: [477, 170], standard: [304, 130], bold: [223, 100] };
const BASIS: MigrationBasis = {
  gapTypicalSeconds: (i) => GAP[i.caution][0],
  gapMinimumSeconds: (i) => GAP[i.caution][1],
  checksEveryHoursMin: 0.85,
  audienceSize: { small: { min: 50, max: 2000 }, everyday: { min: 50, max: 20000 }, larger: { min: 50, max: 100000 } },
  likelyCurve: { hardLow: 0.5, bandLow: 0.9, peakLow: 1.0, peakHigh: 1.2, bandHigh: 1.5, hardHigh: 3.0 },
  privateEdge: 0.15,
  refillMax: 10,
  interim: { cleanupPerDay: 50, censusEveryDays: 7, checksEveryHours: 1 },
};
const migrate = (file: unknown, opts: Partial<{ mtimeMs: number | null; pk: string | null }> = {}): MigrationOutcome =>
  migrateV1(typeof file === 'string' ? file : JSON.stringify(file),
    { now: NOW, legacyAccountPk: opts.pk ?? null, mtimeMs: opts.mtimeMs ?? null, basis: BASIS });
const doc = (file: unknown) => {
  const out = migrate(file);
  if (out.kind !== 'migrated') throw new Error(`refused: ${out.reasons.join(',')}`);
  return out.doc;
};
const v1 = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const notes = (file: unknown) => doc(file).migration?.notes.map((n) => n.kind) ?? [];

describe('golden fixtures', () => {
  test('the default file: balanced intent, no overrides, cleanup of own follows off', () => {
    const d = doc(v1());
    expect(d.overrides).toEqual({});
    expect(d.intent).toMatchObject({ activity: 'moderate', caution: 'standard', rhythm: 'sessions', consistency: 'natural',
      quietHours: { kind: 'derived' }, cleanup: 'off', mutuals: 'rotate', audienceSize: 'everyday', preferPrivate: true });
    expect(d).toMatchObject({ seed: '', protectionState: 'ready', prefs: { practice: false, acceptRequests: true } });
    expect(d.protection).toMatchObject({ accounts: [], words: [], keepVerified: true });
    expect(notes(v1())).toEqual(['quiet-hours-derived', 'cleanup-own-follows-off', 'verified-kept']);
  });

  test('every persona, cautious included, migrates with zero overrides', () => {
    for (const persona of Object.keys(PERSONAS) as Exclude<PersonaId, 'custom'>[]) {
      const d = doc(v1({ persona }));
      expect({ persona, overrides: d.overrides }).toEqual({ persona, overrides: {} });
      expect(d.intent.activity).toBe(PERSONAS[persona].activityLevel);
      expect(d.intent.caution).toBe(PERSONAS[persona].caution);
    }
  });

  test('a custom pattern derives its numbers, so it carries no overrides either', () => {
    const pattern = { ...PERSONAS.balanced, caution: 'cautious' as const, rhythm: 'bursts' as const };
    expect(doc({ ...v1(), persona: 'custom', pattern }).overrides).toEqual({});
  });

  test('a numbers-only file keeps its hand-set numbers as overrides over the frozen derivation', () => {
    const file = { seed: '@Studio.Lumen ', dailyOperatingRate: 40, hourlyVelocityCap: 18 };
    const d = doc(file);
    expect(d.seed).toBe('Studio.Lumen');
    expect(d.overrides['pace.dailyVolume']).toEqual({ value: 40, setAt: NOW, basis: 50 });
    expect(d.overrides['pace.hourlyCap']).toEqual({ value: 18, setAt: NOW, basis: 22 });
  });

  test('messy lists: every string kept or merged, non-strings counted, protection under review', () => {
    const d = doc(v1({
      pruneWhitelist: [' @Jane ', 'jane', 'JANE', '12345', 'bad name', 42, null, ''] as unknown as string[],
      pruneBioFilterWords: ['Café', 'cafe', '  ', 'Shop', 7] as unknown as string[],
    }));
    expect(d.protection.accounts.map((a) => [a.username, a.pk, a.valid])).toEqual([
      ['jane', null, true], ['12345', '12345', true], ['bad name', null, false],
    ]);
    expect(d.protection.words.map((w) => w.text)).toEqual(['Café', 'Shop']);
    expect(d.protectionState).toBe('needs-review');
    expect(d.migration?.notes).toEqual(expect.arrayContaining([
      { kind: 'list-items-dropped', list: 'accounts', count: 2 }, { kind: 'list-items-dropped', list: 'words', count: 1 },
      { kind: 'bio-words-widened', words: 2 },
    ]));
  });

  test('the schedule maps to cleanup: off + schedule is trickle, steady and deep are steady', () => {
    const cleanupOf = (pruneScheduleDays: number, cleanup: Settings['pattern']['cleanup']) =>
      doc({ ...v1({ pruneScheduleDays }), persona: 'custom', pattern: { ...PERSONAS.balanced, cleanup } });
    expect(cleanupOf(7, 'off').intent.cleanup).toBe('trickle');
    expect(notes({ ...v1({ pruneScheduleDays: 7 }), persona: 'custom', pattern: { ...PERSONAS.balanced, cleanup: 'off' } }))
      .toEqual(expect.arrayContaining(['cleanup-scheduled-now-gradual', 'cleanup-trickle-from-schedule']));
    expect(cleanupOf(7, 'steady').intent.cleanup).toBe('steady');
    expect(cleanupOf(0, 'deep').intent.cleanup).toBe('off');
    const deep = cleanupOf(3, 'deep');
    expect(deep.intent.cleanup).toBe('steady');
    expect(deep.overrides['unfollow.censusEveryDays']).toEqual({ value: 3, setAt: NOW, basis: 7 });
    expect(deep.overrides['unfollow.cleanupShare']).toBeUndefined();
  });

  test('an inert refill threshold is clamped to the queue size, with a notice', () => {
    const d = doc(v1({ lowWaterCandidates: 40 }));
    expect(d.overrides['explore.refillBelow']).toEqual({ value: 10, setAt: NOW, basis: 5 });
    expect(d.migration?.notes).toContainEqual({ kind: 'value-clamped', key: 'explore.refillBelow', from: 40, to: 10 });
  });

  test('hand-edited active hours become custom quiet hours; legacy pacing is carried verbatim', () => {
    const d = doc(v1({ activeHoursStart: 9, activeHoursEnd: 21, pacingModel: 'legacy', minDelayMinutes: 4 }));
    expect(d.intent.quietHours).toEqual({ kind: 'custom', startMinute: 1260, endMinute: 540 });
    expect(d.legacyCarry).toEqual({ pacingModel: 'legacy', minDelayMinutes: 4, maxDelayMinutes: 7, jitterPercent: 30,
      activeHoursStart: 9, activeHoursEnd: 21 });
  });

  test('timing rows only slow down: faster values are dropped with a notice', () => {
    // Numbers-only files: a pattern would re-derive the gaps (v1 behaviour).
    const fast = doc({ followbackSweepHours: 0.5, gapFloorSeconds: 30 });
    expect(fast.overrides['checks.everyHours']).toBeUndefined();
    expect(fast.overrides['sessions.gapMinimum']).toBeUndefined();
    expect(fast.migration?.notes).toEqual(expect.arrayContaining([
      { kind: 'faster-value-dropped', key: 'checksEveryHours', from: 0.5 },
      { kind: 'faster-value-dropped', key: 'gapMinimum', from: 30 },
    ]));
    const slow = doc({ followbackSweepHours: 2, gapMedianSeconds: 190 });
    expect(slow.overrides['checks.everyHours']).toEqual({ value: 2, setAt: NOW, basis: 1 });
    expect(slow.overrides['sessions.gapTypical']).toEqual({ value: 608, setAt: NOW, basis: 304 });
  });

  test('the v1 scan band maps to tempo.walk.page: slower only, a factor over the default band, clamped', () => {
    // The v1 default band (1–3 s) is the walk.page reference at tempo 1, so its factor is 1.
    const band = [DEFAULT_SETTINGS.pruneScanMinSeconds, DEFAULT_SETTINGS.pruneScanMaxSeconds];
    expect(((band[0] + band[1]) / 2) * MS_PER_SECOND).toBe(referenceTempoSource().base('walk.page'));
    expect(doc(v1()).overrides['tempo.walk.page']).toBeUndefined();
    const slow = doc(v1({ pruneScanMinSeconds: 2, pruneScanMaxSeconds: 4 }));
    expect(slow.overrides['tempo.walk.page']).toEqual({ value: 1.5, setAt: NOW, basis: 1 });
    expect(slow.migration?.notes.map((n) => n.kind)).not.toContain('value-clamped');
    const slowest = doc(v1({ pruneScanMinSeconds: 10, pruneScanMaxSeconds: 20 }));
    const max = SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR;
    expect(slowest.overrides['tempo.walk.page']).toEqual({ value: max, setAt: NOW, basis: 1 });
    expect(slowest.migration?.notes).toContainEqual({ kind: 'value-clamped', key: 'tempo.walk.page', from: 7.5, to: max });
  });

  test('a faster pruneScan is dropped with a notice: it would speed up every list walk', () => {
    const fast = doc(v1({ pruneScanMinSeconds: 0.5, pruneScanMaxSeconds: 1.5 }));
    expect(fast.overrides).toEqual({});
    expect(fast.migration?.notes).toContainEqual({ kind: 'faster-value-dropped', key: 'pruneScan', from: 1 });
    // The mean decides: a wider band around the same mean is neither slower nor faster.
    const same = doc(v1({ pruneScanMinSeconds: 0.5, pruneScanMaxSeconds: 3.5 }));
    expect(same.overrides).toEqual({});
    expect(same.migration?.notes.map((n) => n.kind)).not.toContain('faster-value-dropped');
  });

  test('audience: buckets match exactly, a curve or range of your own becomes an override', () => {
    expect(doc(v1({ minFollowers: 50, maxFollowers: 2000 })).intent.audienceSize).toBe('small');
    const own = doc(v1({ minFollowers: 100, maxFollowers: 5000, peakHigh: 1.3, privateBoost: 0.3 }));
    expect(own.intent.audienceSize).toBe('everyday');
    expect(own.overrides['audience.followerRange']?.value).toEqual({ min: 100, max: 5000 });
    expect(own.overrides['audience.ratioCurve']?.value).toMatchObject({ peakHigh: 1.3 });
    expect(own.overrides['audience.privateBoost']).toEqual({ value: 0.3, setAt: NOW, basis: 0.15 });
    expect(doc(v1({ privateBoost: 0 })).intent.preferPrivate).toBe(false);
  });

  test('practice, the tour stamp, the bookkeeping and the file digest travel', () => {
    const out = migrate(v1({ dryRun: true, tourCompletedAt: 123, sweepLastRunAt: 456 }), { mtimeMs: 789, pk: '42' });
    if (out.kind !== 'migrated') throw new Error('refused');
    expect(out.doc.prefs.practice).toBe(true);
    expect(out.doc.app.tourCompletedAt).toBe(123);
    expect(out.doc.migration?.bookkeeping).toMatchObject({ forPk: '42', sweepLastRunAt: 456 });
    expect(out.doc.migration?.fromV1).toEqual({ mtimeMs: 789, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  test('a corrupt file is refused, never defaulted', () => {
    expect(migrate('{"seed": ')).toEqual({ kind: 'refused', reasons: ['v1-unparseable'] });
    expect(migrate('[1,2]')).toEqual({ kind: 'refused', reasons: ['v1-unparseable'] });
  });

  test('a refused migration still has an engine view: effectiveFromV1 is today\'s v1 resolution', () => {
    const e = effectiveFromV1(v1({ dryRun: true }));
    expect(e).toMatchObject({ dryRun: true, dailyOperatingRate: 50, rotateMutuals: true, quietHours: null, daysOff: [] });
    // Today's engine reads the scan band itself, so the v1 view carries no tempo override.
    expect(e.tempoOverrides).toEqual({});
    expect(e.boost).toEqual({ hours: SETTINGS_POLICY.BOOST.DEFAULT_HOURS, acceptRequests: true });
  });
});

describe('L-MIG', () => {
  const entry = fc.array(fc.constantFrom('a', 'B', 'j', 'n', '1', '2', '.', '_', '@', ' ', 'é'), { maxLength: 6 })
    .map((cs) => cs.join(''));
  const handle = fc.array(fc.constantFrom('a', 'b', 'j', 'n', '1', '2', '.', '_'), { minLength: 1, maxLength: 5 })
    .map((cs) => cs.join(''));
  const bioWord = fc.array(fc.constantFrom('a', 'B', 'é', 'n', '1', ' '), { minLength: 1, maxLength: 4 })
    .map((cs) => cs.join('')).filter((w) => w.trim().length > 0);

  test('protection is monotone: whatever v1 protected, v2 protects', () => {
    fc.assert(fc.property(fc.array(entry, { maxLength: 5 }), fc.array(bioWord, { maxLength: 3 }),
      fc.record({ pk: fc.constantFrom('1', '12', '21', '9'), username: handle, bio: entry }),
      (whitelist, words, s) => {
        const before = isPruneWhitelisted(s, pruneWhitelistSet(whitelist)) || bioMatchesFilter(s.bio, words);
        if (!before) return;
        const d = doc(v1({ pruneWhitelist: whitelist, pruneBioFilterWords: words }));
        const idx = compileProtection(d.protection, 'ready', 1);
        expect(protectionVerdict({ ...s, isVerified: false }, idx).kind).toBe('protected');
      }), { numRuns: 500 });
  });

  test('no list shrinks: one entry per normalized handle and per folded word', () => {
    fc.assert(fc.property(fc.array(entry, { maxLength: 8 }), fc.array(entry, { maxLength: 8 }), (whitelist, words) => {
      const d = doc(v1({ pruneWhitelist: whitelist, pruneBioFilterWords: words }));
      const handles = new Set(whitelist.map((w) => normalizeHandle(w).handle).filter((h) => h.length > 0));
      expect(new Set(d.protection.accounts.map((a) => a.username))).toEqual(handles);
      const folded = new Set(words.map((w) => foldText(w.trim()).trim()).filter((w) => w.length > 0));
      expect(new Set(d.protection.words.map((w) => foldText(w.text).trim()))).toEqual(folded);
    }), { numRuns: 300 });
  });

  test('idempotent: the same file migrates to the same document', () => {
    const file = v1({ persona: 'nightOwl', pruneWhitelist: ['a', 'b'], pruneScheduleDays: 3, lowWaterCandidates: 40 });
    expect(migrate(file, { mtimeMs: 1 })).toEqual(migrate(file, { mtimeMs: 1 }));
  });
});
