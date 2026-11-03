/**
 * The transitional Settings v2 surface over today's v1 file: the protection the new predicate compiles from
 * the v1 lists, and the view the settings channel serves until the settings core computes it from the v2
 * document. Every number here is today's derivation; the settings core replaces the previews.
 */
import * as path from 'node:path';
import type { PlanPreviewPort } from '@/governors/plan-types';
import { derivePattern, EMPIRICAL } from '@/kernel';
import { deriveReadAllowance } from '@/kernel/derive-reads';
import type { BuiltGraph } from '@/main/services/graph-types';
import { type EffectiveSettings, effectiveFromV1 } from '@/settings/effective';
import { migrateAccountList, migrateWordList } from '@/settings/migrate-v1-lists';
import type { PatternSettings } from '@/settings/pattern-map';
import {
  DEFAULT_SETTINGS, loadSettings, type Settings, sanitizeSettings, saveSettings, toChainConfig, toChurnConfig,
  toFollowbackConfig, toPacingConfig, toPruneConfig, toRateGovernorConfig, toScannerConfig, toScorerConfig,
} from '@/settings/settings';
import {
  ACTIVITY_LEVELS, type AudienceSize, CAUTIONS, CLEANUP_LEVELS, CONSISTENCIES, DAY_SHAPES, type Intent, PACE_CARDS,
  PATIENCES, RHYTHMS,
} from '@/shared/settings-intent';
import type { ProtectionSettings } from '@/shared/settings-model';
import { RISK_LEVELS } from '@/shared/settings-params';
import type { PaceOption, SettingsCapabilities, SettingsView } from '@/shared/settings-view';
import { compileProtection, type ProtectionIndex } from '@/shared/unfollow-protection';
import * as logger from '@/utils/logger';

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

const IG_SETTINGS_FILE = 'epo-settings.json';

export interface SettingsServiceDeps {
  /** Where the settings file lives (beside the knowledge DB). */
  userDataDir: string;
  /** The live graph, or `null` while the session is closed. */
  graph(): BuiltGraph | null;
}

/** @transitional — the v1-internals service production runs until the v2 service is wired. */
export class SettingsService {
  private readonly userDataDir: string;
  /** Settings cached once loaded, so `getSettings`/`updateSettings` share one copy. */
  private settingsCache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();
  /** +1 on every applied change: the revision the compiled protection and the view carry. */
  private rev = 0;
  private capabilities: SettingsCapabilities = { plan: false, tempo: false, boost: false, protectionEverywhere: false };
  private compiled: { readonly rev: number; readonly index: ProtectionIndex } | null = null;
  /** The plan core's what-if port for the settings previews; null until the plan wiring registers it. */
  private previewPort: PlanPreviewPort | null = null;

  constructor(private readonly deps: SettingsServiceDeps) {
    this.userDataDir = deps.userDataDir;
  }

  /** The live graph, or `null` while the session is closed. */
  private get graph(): BuiltGraph | null {
    return this.deps.graph();
  }

  /** Subscribe to every reset and update; fires after the live configs reloaded. */
  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The persisted settings (loaded lazily and cached; defaults on any failure). */
  async getSettings(): Promise<Settings> {
    return this.resolveSettings();
  }

  /** What the engine consumes: every number as the v1 file resolves it. */
  effective(): EffectiveSettings {
    return effectiveFromV1(this.resolveSettings());
  }

  /** The new protection predicate's index over today's v1 lists, compiled once per revision. */
  protection(): ProtectionIndex {
    if (this.compiled === null || this.compiled.rev !== this.rev) {
      this.compiled = { rev: this.rev, index: compileProtection(protectionFromV1(this.resolveSettings()), 'ready', this.rev) };
    }
    return this.compiled.index;
  }

  /** The transitional view the settings channel serves. */
  view(): SettingsView {
    return transitionalView(this.resolveSettings(), this.effective(), this.rev, this.capabilities);
  }

  /** Each wiring site sets its flag once the dependency it names is wired. */
  setCapabilities(patch: Partial<SettingsCapabilities>): void {
    this.capabilities = { ...this.capabilities, ...patch };
  }

  /** The plan wiring registers the preview port (null withdraws it); the `plan` flag stays its own to set. */
  setPlanPort(port: PlanPreviewPort | null): void {
    this.previewPort = port;
  }

  /** The registered preview port, or null: what the settings previews ask for plan-days. */
  planPort(): PlanPreviewPort | null {
    return this.previewPort;
  }

  /**
   * Reset all settings to their defaults (knowledge data + IG session are kept),
   * persist, and — when built — reload the live engine configs.
   */
  async resetSettings(): Promise<Settings> {
    const s: Settings = { ...DEFAULT_SETTINGS };
    this.settingsCache = s;
    try {
      saveSettings(this.settingsFilePath(), s);
    } catch (e) {
      logger.error('foundation.resetSettings: persist failed', { error: String(e) });
    }
    if (this.graph !== null) this.reloadConfigs(s);
    this.changed(s);
    logger.info('foundation: settings reset to defaults');
    return s;
  }

  /**
   * Merge a partial into settings, persist atomically, and — when the engine is
   * built — reload every derived component config live so the change takes effect
   * without a restart. When not built, the merge is only persisted (§5).
   */
  async updateSettings(partial: Partial<Settings>): Promise<Settings> {
    // Sanitize AFTER the merge: IPC payloads are unvalidated renderer input, and
    // a hand-edited settings file already passed through the same clamps at load.
    const next: Settings = sanitizeSettings({ ...this.resolveSettings(), ...partial });
    this.settingsCache = next;
    try {
      saveSettings(this.settingsFilePath(), next);
    } catch (e) {
      logger.error('foundation.updateSettings: persist failed', { error: String(e) });
    }
    if (this.graph !== null) this.reloadConfigs(next);
    this.changed(next);
    return next;
  }

  /** Push the new Settings into every live component's config (no rebuild). */
  private reloadConfigs(s: Settings): void {
    const g = this.graph;
    if (g === null) return;
    g.rate.applyConfig(toRateGovernorConfig(s));
    g.churn.applyConfig(toChurnConfig(s));
    g.scanner.applyConfig(toScannerConfig(s), toScorerConfig(s));
    g.followback.applyConfig(toFollowbackConfig(s));
    g.chain.applyConfig(toChainConfig(s));
    g.pruneEngine.applyConfig(toPruneConfig(s));
    // Organic pacing knobs update live (gap/velocity/volume); a legacy↔organic model
    // switch takes effect on the next graph build (the planner is a construction-time dep).
    g.pacing?.applyConfig(toPacingConfig(s));
    g.churnActions.setDryRun(s.dryRun);
    g.engine.applySettings(s);
    logger.info('foundation: settings reloaded into live engine configs');
  }

  /** Load settings once from disk (merged over defaults) and cache the result. */
  resolveSettings(): Settings {
    if (this.settingsCache === null) {
      this.settingsCache = loadSettings(this.settingsFilePath());
    }
    return this.settingsCache;
  }

  private settingsFilePath(): string {
    return path.join(this.userDataDir, IG_SETTINGS_FILE);
  }

  /** Tell every subscriber; a failing one is logged and never undoes the save. */
  private changed(s: Settings): void {
    this.rev += 1;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        logger.error('settings: change listener failed', { error: String(e) });
      }
    }
  }
}
