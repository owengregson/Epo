import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SCORER_DEFAULTS } from '@/engine/scorer';
import { FOLLOWBACK_DEFAULTS } from '@/engine/followback-watcher';
import {
  DEFAULT_SETTINGS,
  type Settings,
  loadSettings,
  saveSettings,
  toScorerConfig,
  toChurnConfig,
  toRateGovernorConfig,
  toRequestBudgetConfig,
  toFollowbackConfig,
  toScannerConfig,
  toChainConfig,
} from '@/settings/settings';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peanut-settings-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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
    fs.writeFileSync(file, JSON.stringify({ seed: 'someone', dailyOperatingRate: 40 }), 'utf8');

    const loaded = loadSettings(file);
    expect(loaded.seed).toBe('someone');
    expect(loaded.dailyOperatingRate).toBe(40);
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
    });
  });

  test('toChurnConfig converts days → ms (4 days → 345600000 ms)', () => {
    expect(toChurnConfig(DEFAULT_SETTINGS)).toEqual({
      maxWaitForFollowbackMs: 345_600_000,
      holdAfterFollowbackMs: 172_800_000,
      maxRetries: 3,
    });
    expect(toChurnConfig(DEFAULT_SETTINGS).maxWaitForFollowbackMs).toBe(4 * 24 * 3600 * 1000);
  });

  test('toRateGovernorConfig converts minutes → ms (3 min → 180000 ms) and carries caps', () => {
    expect(toRateGovernorConfig(DEFAULT_SETTINGS)).toEqual({
      dailyHardCeiling: 50,
      dailyOperatingRate: 25,
      minDelayMs: 180_000,
      maxDelayMs: 420_000,
      jitterPercent: 30,
      activeHoursStart: 8,
      activeHoursEnd: 22,
    });
    expect(toRateGovernorConfig(DEFAULT_SETTINGS).minDelayMs).toBe(3 * 60_000);
  });

  test('toRequestBudgetConfig converts window minutes → ms (60 min → 3600000 ms)', () => {
    expect(toRequestBudgetConfig(DEFAULT_SETTINGS)).toEqual({
      maxRequestsPerWindow: 200,
      windowMs: 3_600_000,
    });
    expect(toRequestBudgetConfig(DEFAULT_SETTINGS).windowMs).toBe(60 * 60_000);
  });

  test('toFollowbackConfig converts hold days → ms and carries the page-cap default', () => {
    expect(toFollowbackConfig(DEFAULT_SETTINGS)).toEqual({
      holdAfterFollowbackMs: 172_800_000,
      maxPagesPerCheck: FOLLOWBACK_DEFAULTS.maxPagesPerCheck,
    });
  });

  test('toScannerConfig carries the plan size', () => {
    expect(toScannerConfig(DEFAULT_SETTINGS)).toEqual({ dailyPlanSize: 25 });
  });

  test('toChainConfig carries the min-yield gate', () => {
    expect(toChainConfig(DEFAULT_SETTINGS)).toEqual({ minFollowBackRate: 0.15, minPoolSize: 300 });
  });

  test('projections honor non-default settings (custom conversions)', () => {
    const custom: Settings = {
      ...DEFAULT_SETTINGS,
      maxWaitForFollowbackDays: 1,
      minDelayMinutes: 5,
      requestBudgetWindowMinutes: 30,
    };
    expect(toChurnConfig(custom).maxWaitForFollowbackMs).toBe(24 * 3600 * 1000);
    expect(toRateGovernorConfig(custom).minDelayMs).toBe(5 * 60_000);
    expect(toRequestBudgetConfig(custom).windowMs).toBe(30 * 60_000);
  });
});
