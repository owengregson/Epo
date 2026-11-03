/**
 * The Settings rows' handlers and typed fallbacks (Appendix B.9), spread into `src/main/ipc.ts`. The v2 rows
 * run on the settings service; a throw answers the row's typed fallback, never a success. The three v1
 * rows are the transitional window, and `seed:check` keeps its older wire shape until the Settings stage.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import type { Foundation } from '@/main/foundation-wiring';
import { notBuiltFacts } from '@/main/modules/not-built';
import { toLegacySeedCheck } from '@/shared/seed-check';
import * as logger from '@/utils/logger';

type SettingsRow =
  | 'settingsView' | 'applySettings' | 'previewSettings' | 'settingsBasis' | 'settingsFacts' | 'suggestAccounts'
  | 'keptList' | 'checkSeed' | 'getSettings' | 'updateSettings' | 'resetSettings';

export function settingsHandlers(foundation: Foundation): Pick<IpcHandlers, SettingsRow> {
  const settings = foundation.settings;
  return {
    settingsView: () => settings.view(),
    applySettings: (ops) => settings.apply(ops, 'user'),
    previewSettings: (ops) => settings.preview(ops),
    settingsBasis: () => settings.basis(),
    settingsFacts: () => foundation.facts.facts(),
    suggestAccounts: (query, scope) => foundation.facts.suggest(query, scope),
    keptList: (page) => foundation.facts.kept(page),
    checkSeed: async (handle) => toLegacySeedCheck(await foundation.seed.check(handle)),
    getSettings: () => settings.getSettings(),
    updateSettings: (partial) => {
      logger.info('settings:update');
      return settings.updateSettings(partial);
    },
    resetSettings: () => {
      logger.info('settings:reset');
      return settings.resetSettings();
    },
  };
}

export function settingsFallbacks(foundation: Foundation): Pick<IpcFallbacks, SettingsRow> {
  return {
    settingsView: () => foundation.settings.view(),
    applySettings: () => ({ kind: 'refused', reason: 'internal', detail: 'the settings change failed', view: foundation.settings.view() }),
    previewSettings: () => ({ kind: 'unavailable' }),
    settingsBasis: () => ({ kind: 'unavailable' }),
    settingsFacts: () => notBuiltFacts('error'),
    suggestAccounts: () => ({ kind: 'unavailable' }),
    keptList: () => ({ kind: 'unavailable' }),
    checkSeed: () => ({ ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error' }),
    getSettings: () => foundation.settings.getSettings(),
    // The one transitional exception to typed fallbacks: a failed save rejects, so the old UI shows Not saved.
    updateSettings: () => Promise.reject(new Error('settings not saved')),
    resetSettings: () => Promise.reject(new Error('settings not reset')),
  };
}
