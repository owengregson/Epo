/**
 * The Settings rows' handlers and typed fallbacks (Appendix B.9), spread into `src/main/ipc.ts`. Until the
 * settings core lands, the v2 rows answer their typed fallbacks (the view is the service's transitional
 * one); the three v1 rows and `seed:check` keep today's behaviour and today's wire shapes.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import type { Foundation } from '@/main/foundation-wiring';
import { notBuiltFacts } from '@/main/modules/not-built';
import type { SettingsSaveResult } from '@/shared/settings-ops';
import * as logger from '@/utils/logger';

type SettingsRow =
  | 'settingsView' | 'applySettings' | 'previewSettings' | 'settingsBasis' | 'settingsFacts' | 'suggestAccounts'
  | 'keptList' | 'checkSeed' | 'getSettings' | 'updateSettings' | 'resetSettings';

const NOT_WIRED = 'the settings core is not wired yet';

export function settingsHandlers(foundation: Foundation): Pick<IpcHandlers, SettingsRow> {
  const refused = (): SettingsSaveResult =>
    ({ kind: 'refused', reason: 'internal', detail: NOT_WIRED, view: foundation.settings.view() });
  return {
    settingsView: () => foundation.settings.view(),
    applySettings: () => refused(),
    previewSettings: () => ({ kind: 'unavailable' }),
    settingsBasis: () => ({ kind: 'unavailable' }),
    settingsFacts: () => notBuiltFacts('error'),
    suggestAccounts: () => ({ kind: 'unavailable' }),
    keptList: () => ({ kind: 'unavailable' }),
    checkSeed: (username) => foundation.checkSeed(username),
    getSettings: () => foundation.getSettings(),
    updateSettings: (partial) => {
      logger.info('settings:update');
      return foundation.updateSettings(partial);
    },
    resetSettings: () => {
      logger.info('settings:reset');
      return foundation.resetSettings();
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
    getSettings: () => foundation.getSettings(),
    // The one transitional exception to typed fallbacks: a failed save rejects, so the old UI shows Not saved.
    updateSettings: () => Promise.reject(new Error('settings not saved')),
    resetSettings: () => Promise.reject(new Error('settings not reset')),
  };
}
