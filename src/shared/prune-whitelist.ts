/**
 * The v1 list semantics (the whitelist and the bio keep-list), kept only for the old Prune page
 * and as the settings migration's oracle; every unfollow path reads the protection predicate
 * (`unfollow-protection.ts`). Deleted with the v1 lists.
 */

/** The slice of a prune candidate the whitelist test needs. */
export interface WhitelistSubject {
  pk: string;
  username: string | null;
}

/** Normalize a whitelist to a lowercase lookup set (blank entries dropped). */
export function pruneWhitelistSet(whitelist: string[]): Set<string> {
  return new Set(whitelist.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0));
}

/** Whether one candidate is protected by the (already-normalized) set. */
export function isPruneWhitelisted(cand: WhitelistSubject, set: Set<string>): boolean {
  if (set.size === 0) return false;
  if (set.has(cand.pk.toLowerCase())) return true;
  return cand.username !== null && set.has(cand.username.toLowerCase());
}

/** The actionable subset of a raw candidate census under `whitelist`. */
export function filterPruneCandidates<T extends WhitelistSubject>(
  candidates: T[],
  whitelist: string[],
): T[] {
  const set = pruneWhitelistSet(whitelist);
  if (set.size === 0) return candidates;
  return candidates.filter((c) => !isPruneWhitelisted(c, set));
}

/** The v1 bio keep-list match: a case-insensitive substring of the bio; blank words and an unseen bio never match. */
export function bioMatchesFilter(bio: string | undefined, words: readonly string[]): boolean {
  if (bio === undefined || bio === '') return false;
  const haystack = bio.toLowerCase();
  return words.some((w) => {
    const needle = w.trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}
