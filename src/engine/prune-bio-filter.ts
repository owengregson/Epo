/**
 * The prune bio filter: accounts whose profile bio contains any configured
 * word/phrase are protected from prune unfollows — a content-based sibling of
 * the username whitelist (prune-whitelist.ts). Matching is a case-insensitive
 * substring test, so entries can be single words ("dog") or phrases
 * ("small business"). Blank entries are ignored — a stray space must never
 * protect every account. An unknown bio never matches here; whether to fetch
 * one first is the PruneEngine's decision.
 */
export function bioMatchesFilter(bio: string | undefined, words: readonly string[]): boolean {
  if (bio === undefined || bio === '') return false;
  const haystack = bio.toLowerCase();
  return words.some((w) => {
    const needle = w.trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}
