/**
 * The Settings rows' handlers and typed fallbacks (Appendix B.9), spread into `src/main/ipc.ts`. The v2 rows
 * run on the settings service; a throw answers the row's typed fallback, never a success. `seed:check`
 * answers the typed result.
 */

import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import type { Foundation } from '@/main/foundation-wiring';
import { notBuiltFacts } from '@/main/modules/not-built';

type SettingsRow =
  | 'settingsView' | 'applySettings' | 'previewSettings' | 'settingsBasis' | 'settingsFacts' | 'suggestAccounts'
  | 'keptList' | 'checkSeed';

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
    checkSeed: (handle) => foundation.seed.check(handle),
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
    checkSeed: () => ({ kind: 'unreadable', why: 'error' }),
  };
}
