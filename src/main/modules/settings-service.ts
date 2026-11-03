/**
 * The settings service: loads, caches, persists and live-reloads the v1
 * settings file for the Foundation, so every reader shares one copy.
 */

import * as path from 'node:path';
import type { BuiltGraph } from '@/main/services/graph-types';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  type Settings,
  sanitizeSettings,
  saveSettings,
  toChainConfig,
  toChurnConfig,
  toFollowbackConfig,
  toPacingConfig,
  toPruneConfig,
  toRateGovernorConfig,
  toScannerConfig,
  toScorerConfig,
} from '@/settings/settings';
import * as logger from '@/utils/logger';

const IG_SETTINGS_FILE = 'epo-settings.json';

export interface SettingsServiceDeps {
  /** Where the settings file lives (beside the knowledge DB). */
  userDataDir: string;
  /** The live graph, or `null` while the session is closed. */
  graph(): BuiltGraph | null;
}

export class SettingsService {
  private readonly userDataDir: string;
  /** Settings cached once loaded, so `getSettings`/`updateSettings` share one copy. */
  private settingsCache: Settings | null = null;
  private readonly listeners = new Set<(s: Settings) => void>();

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
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch (e) {
        logger.error('settings: change listener failed', { error: String(e) });
      }
    }
  }
}
