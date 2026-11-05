/** Read a refused v1 migration without discarding raw protection or Practice mode. */
import { DEFAULT_DOC, type MigrationNote, type SettingsDocV2 } from './doc';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import { migrateLegacyPattern, sanitizeSettings } from './v1/settings-v1';
import type { Settings } from './v1/settings-v1-types';

/** What a refused migration runs on (spec §6.10): v1's own numbers, its raw lists as protection, practice carried. */
export function refusedState(raw: string, now: number):
  { readonly kind: 'v1'; readonly v1: Settings; readonly doc: SettingsDocV2 } | { readonly kind: 'unreadable'; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'unreadable', error: String(e) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'unreadable', error: 'not a settings object' };
  const file = parsed as Partial<Settings>;
  const v1 = sanitizeSettings(migrateLegacyPattern({ ...file }));
  const accounts = migrateAccountList(file.pruneWhitelist, now);
  const words = migrateWordList(file.pruneBioFilterWords, now);
  const notes: MigrationNote[] = [];
  if (accounts.nonString > 0) notes.push({ kind: 'list-items-dropped', list: 'accounts', count: accounts.nonString });
  if (words.nonString > 0) notes.push({ kind: 'list-items-dropped', list: 'words', count: words.nonString });
  const protection = { ...DEFAULT_DOC.protection, accounts: accounts.accounts, words: words.words };
  const doc: SettingsDocV2 = { ...DEFAULT_DOC, seed: v1.seed, protection, protectionState: 'needs-review',
    app: { ...DEFAULT_DOC.app, tourCompletedAt: v1.tourCompletedAt },
    migration: notes.length === 0 ? null : { at: now, fromV1: null, bookkeeping: null, notes },
    prefs: { ...DEFAULT_DOC.prefs, practice: v1.dryRun, acceptRequests: v1.autoAcceptFollowRequests } };
  return { kind: 'v1', v1, doc };
}
