import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SCORER_DEFAULTS } from '@/engine/scorer';
import {
  DEFAULT_SETTINGS,
  type Settings,
  loadSettings,
  saveSettings,
  toScorerConfig,
  toChurnConfig,
  toRateGovernorConfig,
  toFollowbackConfig,
  toScannerConfig,
  toChainConfig,
  toPruneConfig,
  toPacingConfig,
} from '@/settings/settings';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-settings-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('organic pacing settings', () => {
  test('toPacingConfig maps display units to the planner config', () => {
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      dailyOperatingRate: 30,
      dailyVolumeVariancePct: 20,
      restDayChancePct: 10,
      sessionsPerDayMin: 2,
      sessionsPerDayMax: 5,
      gapMedianSeconds: 100,
      gapFloorSeconds: 50,
      hourlyVelocityCap: 18,
    };
    const c = toPacingConfig(s);
    expect(c.dailyMeanActions).toBe(30);
    expect(c.dailyHardCeiling).toBe(s.dailyHardCeiling);
    expect(c.dayVolumeSigma).toBeCloseTo(0.2, 6);
    expect(c.restDayProbability).toBeCloseTo(0.1, 6);
    expect(c.sessionsPerDayMin).toBe(2);
    expect(c.sessionsPerDayMax).toBe(5);
    expect(c.gapMedianMs).toBe(100_000);
    expect(c.gapFloorMs).toBe(50_000);
    expect(c.maxActionsPerRollingHour).toBe(18);
  });

  test('sanitize clamps and orders the new knobs, and rejects a bad pacingModel', () => {
    const file = path.join(dir, 's.json');
    saveSettings(file, {
      ...DEFAULT_SETTINGS,
      persona: 'custom', // custom mode keeps (and clamps) the raw numeric knobs
      dailyVolumeVariancePct: 999,
      restDayChancePct: -5,
      sessionsPerDayMin: 8,
      sessionsPerDayMax: 3,
      gapMedianSeconds: 40,
      gapFloorSeconds: 200,
      hourlyVelocityCap: 999,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the sanitizer with a bad value
      pacingModel: 'weird' as any,
    });
    const s = loadSettings(file);
    expect(s.dailyVolumeVariancePct).toBeLessThanOrEqual(60);
    expect(s.restDayChancePct).toBeGreaterThanOrEqual(0);
    expect(s.sessionsPerDayMax).toBeGreaterThanOrEqual(s.sessionsPerDayMin);
    expect(s.gapFloorSeconds).toBeLessThanOrEqual(s.gapMedianSeconds);
    expect(s.hourlyVelocityCap).toBeLessThanOrEqual(40);
    expect(s.pacingModel).toBe('legacy');
  });

  test('a named persona derives the numeric knobs from its bundle', () => {
    const file = path.join(dir, 'persona.json');
    saveSettings(file, { ...DEFAULT_SETTINGS, persona: 'grower', dailyOperatingRate: 999 });
    const s = loadSettings(file);
    expect(s.persona).toBe('grower');
    expect(s.dailyOperatingRate).toBe(75); // 'active' — the hand-set 999 is ignored
    expect(s.dailyHardCeiling).toBe(Math.round(75 * 1.3));
  });

  test('a legacy file with no persona keeps its numbers as custom (migration-safe)', () => {
    const file = path.join(dir, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({ seed: 'x', dailyOperatingRate: 37 }), 'utf8');
    const s = loadSettings(file);
    expect(s.persona).toBe('custom');
    expect(s.dailyOperatingRate).toBe(37); // preserved, not snapped to a persona default
  });
});

describe('persistence', () => {
  test('DEFAULT_SETTINGS round-trips through save → load', () => {
    const file = path.join(dir, 'settings.json');
    saveSettings(file, DEFAULT_SETTINGS);
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  test('loadSettings on a missing path returns defaults (no throw)', () => {
    const file = path.join(dir, 'does-not-exist.json');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  test('loadSettings on invalid JSON returns defaults (no throw)', () => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ not valid json', 'utf8');
    expect(loadSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  test('a partial JSON merges over defaults', () => {
    const file = path.join(dir, 'partial.json');
    fs.writeFileSync(file, JSON.stringify({ seed: 'someone', dailyOperatingRate: 30 }), 'utf8');

    const loaded = loadSettings(file);
    expect(loaded.seed).toBe('someone');
    expect(loaded.dailyOperatingRate).toBe(30);
    // Untouched keys retain their defaults.
    expect(loaded.dailyHardCeiling).toBe(DEFAULT_SETTINGS.dailyHardCeiling);
    expect(loaded.minFollowers).toBe(DEFAULT_SETTINGS.minFollowers);
    expect(loaded.dryRun).toBe(DEFAULT_SETTINGS.dryRun);
  });

  test('saveSettings writes atomically (no leftover temp file)', () => {
    const file = path.join(dir, 'settings.json');
    saveSettings(file, DEFAULT_SETTINGS);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('projections from DEFAULT_SETTINGS', () => {
  test('toScorerConfig carries ratio + size bounds and the non-tunable bandEdgeScore', () => {
    expect(toScorerConfig(DEFAULT_SETTINGS)).toEqual({
      bandLow: 0.9,
      bandHigh: 1.5,
      peakLow: 1.0,
      peakHigh: 1.2,
      hardLow: 0.5,
      hardHigh: 3.0,
      minFollowers: 50,
      maxFollowers: 20000,
      privateBoost: 0.15,
      bandEdgeScore: SCORER_DEFAULTS.bandEdgeScore,
      mutualCap: SCORER_DEFAULTS.mutualCap,
      mutualWeight: SCORER_DEFAULTS.mutualWeight,
    });
  });

  test('toChurnConfig converts days → ms (4 days → 345600000 ms); the hold belongs to followback', () => {
    expect(toChurnConfig(DEFAULT_SETTINGS)).toEqual({
      maxWaitForFollowbackMs: 345_600_000,
      maxRetries: 3,
    });
    expect(toChurnConfig(DEFAULT_SETTINGS).maxWaitForFollowbackMs).toBe(4 * 24 * 3600 * 1000);
  });

  test('toRateGovernorConfig converts minutes → ms (3 min → 180000 ms) and carries caps', () => {
    expect(toRateGovernorConfig(DEFAULT_SETTINGS)).toEqual({
      dailyHardCeiling: 65,
      dailyOperatingRate: 50,
      minDelayMs: 180_000,
      maxDelayMs: 420_000,
      jitterPercent: 30,
      activeHoursStart: 8,
      activeHoursEnd: 22,
    });
    expect(toRateGovernorConfig(DEFAULT_SETTINGS).minDelayMs).toBe(3 * 60_000);
  });

  test('toFollowbackConfig converts hold days → ms and carries auto-accept', () => {
    expect(toFollowbackConfig(DEFAULT_SETTINGS)).toEqual({
      holdAfterFollowbackMs: 172_800_000,
      autoAcceptRequests: true,
    });
  });

  test('the follow-back check defaults to an HOURLY cadence (notifications-based)', () => {
    expect(DEFAULT_SETTINGS.followbackSweepHours).toBe(1);
  });

  test('toScannerConfig carries the plan size', () => {
    expect(toScannerConfig(DEFAULT_SETTINGS)).toEqual({ dailyPlanSize: 60 });
  });

  test('toChainConfig carries the min-yield gate', () => {
    expect(toChainConfig(DEFAULT_SETTINGS)).toEqual({ minFollowBackRate: 0.15, minPoolSize: 300 });
  });

  test('toPruneConfig carries the prune cap/whitelist and shares the delay knobs (minutes → ms)', () => {
    expect(toPruneConfig(DEFAULT_SETTINGS)).toEqual({
      dailyLimit: 50,
      whitelist: [],
      bioFilterWords: [],
      minDelayMs: 180_000,
      maxDelayMs: 420_000,
      jitterPercent: 30,
      scanMinMs: 1_000,
      scanMaxMs: 3_000,
    });
    expect(
      toPruneConfig({
        ...DEFAULT_SETTINGS,
        pruneWhitelist: ['Keep_Me'],
        pruneDailyLimit: 5,
        pruneBioFilterWords: ['dog mom'],
      }),
    ).toEqual({
      dailyLimit: 5,
      whitelist: ['Keep_Me'],
      bioFilterWords: ['dog mom'],
      minDelayMs: 180_000,
      maxDelayMs: 420_000,
      jitterPercent: 30,
      scanMinMs: 1_000,
      scanMaxMs: 3_000,
    });
  });

  test('toPruneConfig maps the scan pacing knobs (seconds → ms) and clamps max ≥ min ≥ 0', () => {
    const custom = toPruneConfig({
      ...DEFAULT_SETTINGS,
      pruneScanMinSeconds: 3,
      pruneScanMaxSeconds: 8,
    });
    expect(custom.scanMinMs).toBe(3_000);
    expect(custom.scanMaxMs).toBe(8_000);

    // An inverted pair clamps max up to min (never a max below the min).
    const inverted = toPruneConfig({
      ...DEFAULT_SETTINGS,
      pruneScanMinSeconds: 10,
      pruneScanMaxSeconds: 3,
    });
    expect(inverted.scanMinMs).toBe(10_000);
    expect(inverted.scanMaxMs).toBe(10_000);

    // A negative min clamps to 0 (a wait can never be negative).
    const negative = toPruneConfig({
      ...DEFAULT_SETTINGS,
      pruneScanMinSeconds: -4,
      pruneScanMaxSeconds: 2,
    });
    expect(negative.scanMinMs).toBe(0);
    expect(negative.scanMaxMs).toBe(2_000);
  });

  test('prune knobs round-trip through save → load and merge over defaults', () => {
    const file = path.join(dir, 'prune.json');
    saveSettings(file, { ...DEFAULT_SETTINGS, pruneWhitelist: ['a', 'B'], pruneLastRunAt: 123 });
    const loaded = loadSettings(file);
    expect(loaded.pruneWhitelist).toEqual(['a', 'B']);
    expect(loaded.pruneLastRunAt).toBe(123);
    expect(loaded.pruneDailyLimit).toBe(DEFAULT_SETTINGS.pruneDailyLimit);
    expect(loaded.pruneScheduleDays).toBe(DEFAULT_SETTINGS.pruneScheduleDays);
  });

  test('projections honor non-default settings (custom conversions)', () => {
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      maxWaitForFollowbackDays: 1,
      minDelayMinutes: 5,
    };
    expect(toChurnConfig(custom).maxWaitForFollowbackMs).toBe(24 * 3600 * 1000);
    expect(toRateGovernorConfig(custom).minDelayMs).toBe(5 * 60_000);
  });
});

describe('sanitizeSettings', () => {
  const { sanitizeSettings } = require('@/settings/settings');

  test('clamps hostile numeric values into safe ranges', () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      jitterPercent: 100,
      minDelayMinutes: -5,
      maxDelayMinutes: 0,
      dailyOperatingRate: 40,
      dailyHardCeiling: 10, // below the rate → lifted to it
    });
    expect(s.jitterPercent).toBe(90);
    expect(s.minDelayMinutes).toBe(0.5);
    expect(s.maxDelayMinutes).toBeGreaterThanOrEqual(s.minDelayMinutes);
    expect(s.dailyHardCeiling).toBeGreaterThanOrEqual(s.dailyOperatingRate);
  });

  test('repairs non-array whitelist and NaN values', () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      pruneWhitelist: null as any,
      maxFollowers: NaN as any,
      minFollowers: 100,
    });
    expect(s.pruneWhitelist).toEqual([]);
    expect(s.maxFollowers).toBeGreaterThanOrEqual(s.minFollowers);
  });

  test('enforces the ratio band ordering', () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, bandLow: 2.0, peakLow: 0.1 });
    expect(s.hardLow).toBeLessThanOrEqual(s.bandLow);
    expect(s.bandLow).toBeLessThanOrEqual(s.peakLow);
    expect(s.peakLow).toBeLessThanOrEqual(s.peakHigh);
    expect(s.peakHigh).toBeLessThanOrEqual(s.bandHigh);
    expect(s.bandHigh).toBeLessThanOrEqual(s.hardHigh);
  });
});
