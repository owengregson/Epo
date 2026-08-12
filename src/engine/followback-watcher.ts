import type { KnowledgeStore } from '../store/knowledge-store';
import type { Clock } from '../governors/clock';
import { warn } from '../utils/logger';

/**
 * A paginated source of OUR OWN followers, most-recent-first. The real implementation
 * fetches via a browser tab + Reader; tests inject a scripted fake. Kept as a narrow
 * interface so the Follow-back Watcher is fully unit-testable without a browser.
 */
export interface OwnFollowersSource {
  /** Fetch the next page of our followers. `cursor` is null for the first page. */
  nextPage(cursor: string | null): Promise<{ pks: string[]; cursor: string | null; hasMore: boolean }>;
}

/** Tunable knobs for the Follow-back Watcher (v3 §5.1). Exposed in Settings. */
export interface FollowbackConfig {
  /** How long to hold a reciprocated follow before it can be unfollowed. Sets `holdUntil`. */
  holdAfterFollowbackMs: number;
  /** Hard cap on pages read per `check()`, so one check is always request-bounded. */
  maxPagesPerCheck: number;
}

/** Design defaults (v3 §5.1): 2-day hold, at most 10 pages per check. */
export const FOLLOWBACK_DEFAULTS: FollowbackConfig = {
  holdAfterFollowbackMs: 2 * 24 * 3600 * 1000,
  maxPagesPerCheck: 10,
};

interface FollowbackDeps {
  store: KnowledgeStore;
  clock: Clock;
  /** Our own account PK — the destination of every "follows us" edge. */
  ownPk: string;
  followers: OwnFollowersSource;
  cfg?: FollowbackConfig;
}

/**
 * Request-minimal follow-back detection (v3 §5.1, backstop method).
 *
 * New followers arrive at the TOP of our own followers list, so we read page-by-page
 * and STOP as soon as a page yields no new followers — we have scrolled past the new
 * arrivals. Cost is O(new), never O(all). The watcher never fetches anything when there
 * are no pending follows to resolve.
 */
export class FollowbackWatcher {
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly ownPk: string;
  private readonly followers: OwnFollowersSource;
  private readonly cfg: FollowbackConfig;

  constructor(deps: FollowbackDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ownPk = deps.ownPk;
    this.followers = deps.followers;
    this.cfg = deps.cfg ?? FOLLOWBACK_DEFAULTS;
  }

  /**
   * Detect which of our pending follows have followed us back, transitioning each to
   * `followed_back` with a hold timer. Returns the PKs newly detected this run.
   */
  async check(): Promise<{ detected: string[] }> {
    const detected: string[] = [];

    // 1. Nothing pending → don't fetch anything (request-minimal).
    const pending = new Set(
      this.store.followRecordsByState('pending_followback').map((r) => r.accountPk),
    );
    if (pending.size === 0) return { detected };

    // 2. Read our followers head, page-by-page, up to the hard cap.
    let cursor: string | null = null;
    for (let page = 0; page < this.cfg.maxPagesPerCheck; page++) {
      let result: { pks: string[]; cursor: string | null; hasMore: boolean };
      try {
        result = await this.followers.nextPage(cursor);
      } catch (err) {
        // No silent catches: surface the failure and stop this check.
        warn('followback: own-followers page fetch failed', { page, error: String(err) });
        break;
      }

      const now = this.clock.now();
      let newFollowersThisPage = 0;

      for (const pk of result.pks) {
        const edge = this.store.getEdge(pk, this.ownPk, 'follows');
        const alreadyKnown = edge !== null && edge.status === 'active';
        if (!alreadyKnown) {
          // A NEW follower of ours: record the directed edge pk -> ownPk.
          this.store.observeEdge(pk, this.ownPk, 'follows', true, now);
          newFollowersThisPage += 1;
        }

        if (pending.has(pk)) {
          const rec = this.store.getFollowRecord(pk);
          if (rec) {
            this.store.upsertFollowRecord({
              ...rec,
              state: 'followed_back',
              followedBackAt: now,
              holdUntil: now + this.cfg.holdAfterFollowbackMs,
            });
            detected.push(pk);
          }
          pending.delete(pk);
        }
      }

      // Stop conditions:
      if (pending.size === 0) break; // every pending follow resolved
      if (newFollowersThisPage === 0) break; // INCREMENTAL STOP: scrolled past new arrivals
      if (!result.hasMore) break; // source exhausted
      cursor = result.cursor;
    }

    return { detected };
  }
}
