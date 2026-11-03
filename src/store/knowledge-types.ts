/**
 * The last COMPLETE prune census: the settled counts of the most recent scan
 * that verifiably walked both lists to the end, plus the scraped basis every
 * derived composition figure rests on. Persisted in the meta table (see
 * {@link KnowledgeStore.savePruneCensus}) so it survives relaunch, and only
 * ever replaced by the NEXT complete scan — an aborted or failed scan and a
 * run that consumes the candidate rows all leave it standing.
 */
export interface PruneCensusRecord {
  /** Epoch ms the census-completing scan finished. */
  at: number;
  /** Display counts: scraped list + ghost buffer = the numbers Instagram's
   *  own profile header shows (see the GHOST BUFFER note in prune-engine). */
  following: number;
  followers: number;
  /** The walked lists' true sizes — what the list API actually returned. The
   *  gap to `following`/`followers` is deactivated/unavailable accounts the
   *  header still counts but the list never resolves ("unresolvable"). */
  scrapedFollowing: number;
  scrapedFollowers: number;
  /** Scraped follows of ours with no reciprocal follower row (self excluded). */
  notFollowingBack: number;
  /** Of those, the raw prune census: growth-managed accounts and chain targets
   *  excluded, whitelist NOT applied (the runnable set derives from it live). */
  candidates: number;
}

/** Ambient dependencies a store may take instead of reaching for globals. */
export interface KnowledgeStoreOptions {
  /** Wall clock; defaults to `Date.now`. */
  now?: () => number;
  /** Uniform [0,1) source for install entropy and span ids; main injects the entropy root. */
  rng?: () => number;
}

/** The store owns no randomness: without an injected `rng`, a draw refuses loudly. */
export function noInjectedRng(): number {
  throw new Error('store: no rng injected (the composition root passes the entropy root)');
}

