/**
 * The Settings v2 invoke rows (spec §15.1, Appendix B.9): channel strings are
 * written here once and spread into `CHANNELS`; `IpcContract` extends the
 * contract. Dependency-free: type-only imports plus one frozen literal.
 */

import type { KeptPageResult, SettingsFacts, SuggestResult } from '@/shared/settings-facts';
import type { SettingsOp, SettingsPreviewResult, SettingsSaveResult } from '@/shared/settings-ops';
import type { BasisResult, SettingsView } from '@/shared/settings-view';

export const SETTINGS_CHANNELS = {
  settingsView: 'settings:view',
  applySettings: 'settings:apply',
  previewSettings: 'settings:preview',
  settingsBasis: 'settings:basis',
  settingsFacts: 'settings:facts',
  suggestAccounts: 'accounts:suggest',
  keptList: 'protection:kept',
} as const;

export interface SettingsIpcContract {
  /** The Settings stage's view, computed by main per revision. */
  settingsView: { req: []; res: SettingsView };
  /** Apply ops atomically through the one writer; typed saved / not-saved / refused. */
  applySettings: { req: [ops: readonly SettingsOp[]]; res: SettingsSaveResult };
  /** What-if: the view the ops would produce. Pure; nothing persists. */
  previewSettings: { req: [ops: readonly SettingsOp[]]; res: SettingsPreviewResult };
  /** The Under-the-hood catalog of every kernel tier-1 entry. */
  settingsBasis: { req: []; res: BasisResult };
  /** The store-derived facts (also a projection row). */
  settingsFacts: { req: []; res: SettingsFacts };
  /** Store-only account suggestions for the protection field. */
  suggestAccounts: { req: [query: string, scope: 'following' | 'known']; res: SuggestResult };
  /** One page of the kept table. */
  keptList: { req: [page: number]; res: KeptPageResult };
}
