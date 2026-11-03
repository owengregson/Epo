/**
 * The two v1 protection lists, read from the RAW file (spec §6.10): every item
 * accounted for. Handles go through the one `normalizeHandle`, words through the
 * one `foldText`, so the migration's monotone-protection law holds by construction.
 */
import type { KeepWord, ProtectedAccount } from '@/shared/settings-model';
import { foldText, normalizeHandle } from '@/shared/unfollow-protection';

export interface MigratedAccounts {
  readonly accounts: readonly ProtectedAccount[];
  /** Raw items that were not strings (each one puts protection under review). */
  readonly nonString: number;
  /** Unique normalized non-blank handles: the post-condition the list must meet. */
  readonly uniqueHandles: number;
}

export interface MigratedWords {
  readonly words: readonly KeepWord[];
  readonly nonString: number;
  /** Unique folded non-blank words: the post-condition the list must meet. */
  readonly uniqueFolded: number;
}

const items = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);
const ALL_DIGITS = /^\d+$/;

/** The v1 whitelist: valid handles unlinked, all-digit entries matching pk or handle, invalid ones kept. */
export function migrateAccountList(raw: unknown, now: number): MigratedAccounts {
  const seen = new Set<string>();
  const accounts: ProtectedAccount[] = [];
  let nonString = 0;
  for (const item of items(raw)) {
    if (typeof item !== 'string') {
      nonString += 1;
      continue;
    }
    const { handle, valid } = normalizeHandle(item);
    if (handle.length === 0 || seen.has(handle)) continue;
    seen.add(handle);
    accounts.push({
      pk: ALL_DIGITS.test(handle) ? handle : null,
      username: handle,
      linkedAt: null,
      formerUsernames: [],
      addedAt: now,
      source: 'migrated',
      valid,
    });
  }
  return { accounts, nonString, uniqueHandles: seen.size };
}

/** The v1 bio keep-words: trimmed, non-blank, deduped by fold (the first spelling is kept). */
export function migrateWordList(raw: unknown, now: number): MigratedWords {
  const seen = new Set<string>();
  const words: KeepWord[] = [];
  let nonString = 0;
  for (const item of items(raw)) {
    if (typeof item !== 'string') {
      nonString += 1;
      continue;
    }
    const text = item.trim();
    const folded = foldText(text).trim();
    if (folded.length === 0 || seen.has(folded)) continue;
    seen.add(folded);
    words.push({ text, addedAt: now });
  }
  return { words, nonString, uniqueFolded: seen.size };
}
