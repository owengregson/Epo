/**
 * Edits an older build made to the v1 file after the migration (spec §6.10, §16.4): seen through the file's
 * `{mtimeMs, sha256}` and offered back union-only. Only additions to the two protection lists return; a
 * removal made there never applies, and no other v1 value is read again.
 */
import { createHash } from 'node:crypto';
import type { KeepWord, ProtectedAccount } from '@/shared/settings-model';
import { foldText } from '@/shared/unfollow-protection';
import * as logger from '@/utils/logger';
import type { MigrationRecord, SettingsDocV2 } from './doc';
import { migrateAccountList, migrateWordList } from './migrate-v1-lists';
import { SETTINGS_FILES, type SettingsFs } from './persist';

type V1Fingerprint = NonNullable<MigrationRecord['fromV1']>;

/** A v1 file rewritten since the document last read it: its fingerprint and its raw lists. */
export interface ChangedV1 {
  readonly from: V1Fingerprint;
  readonly whitelist: unknown;
  readonly words: unknown;
}

/** What the older build added that the document does not hold. */
export interface OlderVersionOffer {
  readonly from: V1Fingerprint;
  readonly accounts: readonly ProtectedAccount[];
  readonly words: readonly KeepWord[];
}

/** The v1 file when it changed since the migration read it; null when unchanged, missing or unreadable (logged). */
export function readChangedV1(fs: SettingsFs, dir: string, record: MigrationRecord | null): ChangedV1 | null {
  const seen = record?.fromV1 ?? null;
  const path = `${dir}/${SETTINGS_FILES.v1}`;
  if (seen === null || !fs.exists(path)) return null;
  try {
    const mtimeMs = fs.mtimeMs(path);
    if (mtimeMs === seen.mtimeMs) return null;
    const raw = fs.readFile(path);
    const sha256 = createHash('sha256').update(raw).digest('hex');
    if (sha256 === seen.sha256) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not a JSON object');
    const v1 = parsed as Readonly<Record<string, unknown>>;
    return { from: { mtimeMs, sha256 }, whitelist: v1.pruneWhitelist, words: v1.pruneBioFilterWords };
  } catch (e) {
    logger.warn("settings: the older version's settings file is unreadable; nothing is offered back", { error: String(e) });
    return null;
  }
}

/** The v1 items the document lacks (by handle or pk, by folded word); null when none or already read. */
export function olderVersionOffer(doc: SettingsDocV2, v1: ChangedV1 | null, now: number): OlderVersionOffer | null {
  if (v1 === null || doc.migration?.fromV1?.sha256 === v1.from.sha256) return null;
  const held = doc.protection;
  const accounts = migrateAccountList(v1.whitelist, now).accounts
    .filter((a) => !held.accounts.some((b) => b.username === a.username || (a.pk !== null && a.pk === b.pk)))
    .map((a): ProtectedAccount => ({ ...a, source: 'older-version' }));
  const folded = new Set(held.words.map((w) => foldText(w.text).trim()));
  const words = migrateWordList(v1.words, now).words.filter((w) => !folded.has(foldText(w.text).trim()));
  return accounts.length + words.length === 0 ? null : { from: v1.from, accounts, words };
}
