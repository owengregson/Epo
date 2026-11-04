/** Read a refused v1 migration without discarding raw protection or Practice mode. */
import { DEFAULT_DOC, type SettingsDocV2 } from './doc';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import { migrateLegacyPattern, sanitizeSettings } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

/** What a refused migration runs on (spec §6.10): v1's own numbers, its raw lists as protection, practice carried. */
export function refusedState(raw: string, now: number):
  { readonly kind: 'v1'; readonly v1: Settings; readonly doc: SettingsDocV2 } | { readonly kind: 'unreadable'; readonly error: string } {
  let parsed: Partial<Settings>;
  try {
    parsed = JSON.parse(raw) as Partial<Settings>;
  } catch (e) {
    return { kind: 'unreadable', error: String(e) };
  }
  const v1 = sanitizeSettings(migrateLegacyPattern({ ...parsed }));
  const protection = { ...DEFAULT_DOC.protection, accounts: migrateAccountList(parsed.pruneWhitelist, now).accounts,
    words: migrateWordList(parsed.pruneBioFilterWords, now).words };
  const doc: SettingsDocV2 = { ...DEFAULT_DOC, seed: v1.seed, protection, protectionState: 'needs-review',
    prefs: { ...DEFAULT_DOC.prefs, practice: v1.dryRun, acceptRequests: v1.autoAcceptFollowRequests } };
  return { kind: 'v1', v1, doc };
}

