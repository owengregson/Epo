/**
 * The transitional Settings v2 surface over today's v1 file: the protection the new predicate compiles from
 * the v1 lists, and the view the settings channel serves until the settings core computes it from the v2
 * document. Every number here is today's derivation; the settings core replaces the previews.
 */
import { derivePattern, EMPIRICAL } from '@/kernel';
import { deriveReadAllowance } from '@/kernel/derive-reads';
import type { EffectiveSettings } from '@/settings/effective';
import { migrateAccountList, migrateWordList } from '@/settings/migrate-v1-lists';
import type { PatternSettings } from '@/settings/pattern-map';
import type { Settings } from '@/settings/settings';
import {
  ACTIVITY_LEVELS, type AudienceSize, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES, type Intent, PACE_CARDS,
  PATIENCES, RHYTHMS,
} from '@/shared/settings-intent';
import type { ProtectionSettings } from '@/shared/settings-model';
import { RISK_LEVELS } from '@/shared/settings-params';
import type { PaceOption, SettingsCapabilities, SettingsView } from '@/shared/settings-view';

/** v1's lists as v2 protection settings: verified accounts kept, as the migration sets it. */
export function protectionFromV1(s: Settings): ProtectionSettings {
  return {
    accounts: migrateAccountList(s.pruneWhitelist, 0).accounts,
    words: migrateWordList(s.pruneBioFilterWords, 0).words,
    wordMatch: 'anywhere',
    keepVerified: true,
  };
}

/** The v1 file read as plain intent (the migration's mapping, without its notices). */
export function intentFromV1(s: Settings): Intent {
  const p = s.pattern;
  const defaultHours = s.activeHoursStart === 8 && s.activeHoursEnd === 22;
  return {
    activity: p.activityLevel, caution: p.caution, rhythm: p.rhythm, consistency: p.consistency,
    dayShape: p.dayShape, weeklyShape: p.weeklyShape,
    quietHours: defaultHours ? { kind: 'derived' } : s.activeHoursStart === s.activeHoursEnd ? { kind: 'none' }
      : { kind: 'custom', startMinute: s.activeHoursEnd * 60, endMinute: s.activeHoursStart * 60 },
    daysOff: [], patience: p.patience, mutuals: 'rotate',
    cleanup: s.pruneScheduleDays > 0 ? (p.cleanup === 'steady' || p.cleanup === 'deep' ? 'steady' : 'trickle') : 'off',
    audienceFocus: 'likely', audienceSize: 'everyday', preferPrivate: s.privateBoost > 0,
  };
}

const ACTIVITY_RUNG = { minimal: 0, light: 0, moderate: 1, active: 2, aggressive: 3 } as const;
const CAUTION_RUNG = { cautious: 0, standard: 1, bold: 2 } as const;

function option(id: PaceOption['id'], p: PatternSettings): PaceOption {
  const d = derivePattern(p);
  const day = { typical: d.dailyOperatingRate, low: d.dailyOperatingRate, high: d.dailyOperatingRate };
  return {
    id, perDay: day, perHourMax: d.hourlyVelocityCap,
    shareOfLowWall: d.dailyOperatingRate / EMPIRICAL.FOLLOW_WALL_PER_DAY.low,
    risk: RISK_LEVELS[Math.max(ACTIVITY_RUNG[p.activityLevel], CAUTION_RUNG[p.caution])],
    feasibility: { kind: 'ok', reachablePerDay: d.dailyOperatingRate },
  };
}

const each = <K extends string, V>(keys: readonly K[], f: (k: K) => V): Record<K, V> =>
  Object.fromEntries(keys.map((k) => [k, f(k)])) as Record<K, V>;

/** The view the settings channel serves over v1 (no Advanced rows until the settings core lands). */
export function transitionalView(s: Settings, e: EffectiveSettings, rev: number, capabilities: SettingsCapabilities): SettingsView {
  const p = s.pattern;
  const intent = intentFromV1(s);
  const at = (over: Partial<PatternSettings>): PatternSettings => ({ ...p, ...over });
  const { windowMs: _window, ...reads } = deriveReadAllowance(s);
  const size: Record<AudienceSize, { min: number; max: number }> = {
    small: { min: s.minFollowers, max: s.maxFollowers }, everyday: { min: s.minFollowers, max: s.maxFollowers },
    larger: { min: s.minFollowers, max: s.maxFollowers },
  };
  const curve = { hardLow: s.hardLow, bandLow: s.bandLow, peakLow: s.peakLow, peakHigh: s.peakHigh, bandHigh: s.bandHigh, hardHigh: s.hardHigh };
  const typical = option('balanced', p);
  return {
    rev, health: { kind: 'ok' }, capabilities, mode: 'easy', intent, seed: s.seed, protection: protectionFromV1(s),
    protectionState: 'ready',
    prefs: { practice: s.dryRun, acceptRequests: s.autoAcceptFollowRequests, boost: e.boost },
    easy: { pace: 'custom', size: 'everyday', focus: 'likely', quietHours: null },
    options: {
      paceCards: (Object.keys(PACE_CARDS) as (keyof typeof PACE_CARDS)[]).map((id) =>
        option(id, at({ activityLevel: PACE_CARDS[id].activity, caution: PACE_CARDS[id].caution }))),
      activity: each(ACTIVITY_LEVELS, (a) => option(a, at({ activityLevel: a }))),
      caution: each(CAUTIONS, (c) => {
        const d = derivePattern(at({ caution: c }));
        return { hourlyCap: d.hourlyVelocityCap, minGapSeconds: d.gapFloorSeconds };
      }),
      rhythm: each(RHYTHMS, (r) => {
        const d = derivePattern(at({ rhythm: r }));
        return { sessions: { min: d.sessionsPerDayMin, max: d.sessionsPerDayMax }, gapSeconds: d.gapMedianSeconds };
      }),
      consistency: each(CONSISTENCIES, (c) => {
        const d = derivePattern(at({ consistency: c }));
        return { variationPct: d.dailyVolumeVariancePct, restDayPct: d.restDayChancePct };
      }),
      schedule: DAY_SHAPES.map((dayShape) => ({ dayShape, intensity: [], quiet: null, feasibility: typical.feasibility })),
      patience: each(PATIENCES, (k) => {
        const d = derivePattern(at({ patience: k }));
        return { waitDays: d.maxWaitForFollowbackDays, holdDays: d.holdAfterFollowbackDays };
      }),
      cleanup: each(CLEANUP_LEVELS, (k) => ({ share: derivePattern(at({ cleanup: k })).maxUnfollowFractionPerSession })),
      size,
      focus: { likely: curve, wide: curve },
      boostHours: { choices: [e.boost.hours], min: e.boost.hours, max: e.boost.hours },
    },
    typical: {
      perDay: typical.perDay, automaticMax: s.dailyOperatingRate, ceiling: s.dailyHardCeiling,
      perHourMax: s.hourlyVelocityCap, sessions: { min: s.sessionsPerDayMin, max: s.sessionsPerDayMax },
      shareOfLowWall: typical.shareOfLowWall, risk: typical.risk, feasibility: typical.feasibility, week: null,
    },
    params: [],
    reads: { ...reads, window: 'plan-day', backstop: 'trailing-24h' },
    overrides: { count: 0, stale: 0, bySection: {} },
    effective: {
      seed: s.seed, practice: s.dryRun, acceptRequests: s.autoAcceptFollowRequests,
      waitDays: s.maxWaitForFollowbackDays, holdDays: s.holdAfterFollowbackDays, dailyVolume: s.dailyOperatingRate,
      dailyCeiling: s.dailyHardCeiling, hourlyCap: s.hourlyVelocityCap, quietHours: null, daysOff: [],
      cleanup: intent.cleanup, boostDefaultHours: e.boost.hours,
    },
    notices: [],
    app: { tourCompletedAt: s.tourCompletedAt },
  };
}
