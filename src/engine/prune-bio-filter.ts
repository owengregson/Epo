/**
 * The bio keep-list matcher: whether a profile bio contains any configured
 * word/phrase. Consumed by the ChurnScheduler's keep gate — an account that
 * FOLLOWS US BACK and matches is never rotated out or unfollowed; accounts
 * that don't follow back are pruned regardless of bio (the PruneEngine
 * deliberately ignores bios). Matching is a case-insensitive substring test,
 * so entries can be single words ("cal" matches "calpico gaming") or phrases
 * ("small business"). Blank entries are ignored — a stray space must never
 * protect every account. An unknown bio never matches (facts only).
 */
export function bioMatchesFilter(bio: string | undefined, words: readonly string[]): boolean {
  if (bio === undefined || bio === '') return false;
  const haystack = bio.toLowerCase();
  return words.some((w) => {
    const needle = w.trim().toLowerCase();
    return needle !== '' && haystack.includes(needle);
  });
}
