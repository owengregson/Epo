/**
 * The woven prune feed's selection: the next actionable unfollow from the fresh
 * census, and the growth engine's gate on drawing from the feed at all.
 */

import type { EnginePacing } from './plan-port';
import { decidePruneCandidate } from './prune-candidate';
import type { PruneCandidate, PruneConfig, PruneEngineDeps } from './prune-types';

/** The slice of the PruneEngine the feed selection reads and writes. */
export interface PruneFeedContext {
  readonly deps: PruneEngineDeps;
  readonly cfg: PruneConfig;
  readonly feedHalted: boolean;
  readonly pendingCandidates: PruneCandidate[] | null;
  hasFreshScan(): boolean;
  atDailyCap(now: number): boolean;
  followsUsNow(pk: string): boolean;
  visitCandidate(cand: PruneCandidate): void;
}

/**
 * The next actionable unfollow, or null. Pure selection over the fresh census: skips
 * (permanently, consuming them) any whitelisted / followed-back-since / no-username
 * candidate, and returns null when the feed is halted, no fresh scan exists, or the
 * daily cap is hit. Does NOT consume the returned candidate — that happens in
 * `reportUnfollowOutcome` via `executeUnfollow`.
 */
export function nextFeedCandidate(f: PruneFeedContext, now: number): { pk: string; username: string } | null {
  if (f.feedHalted || !f.hasFreshScan() || f.atDailyCap(now)) return null;
  const pending = f.pendingCandidates;
  if (pending === null) return null;
  while (pending.length > 0) {
    const cand = pending[0];
    // The SAME pure decision the standalone run uses (`prune-candidate.ts`).
    const verdict = decidePruneCandidate({
      candidate: cand,
      whitelist: f.cfg.whitelist,
      followsUsNow: f.followsUsNow(cand.pk),
    });
    if (verdict.do === 'unfollow') return { pk: verdict.pk, username: verdict.username };
    // A permanent skip for this census: drop it and move on. `remaining`
    // tracks the ACTIONABLE census (whitelist already excluded at scan
    // time), so a whitelisted skip consumes the durable row WITHOUT
    // spending an actionable slot — decrementing here would zero the count
    // while actionable candidates still exist.
    pending.shift();
    if (verdict.reason === 'whitelisted') {
      f.deps.store.consumePruneScanCandidate(cand.pk);
    } else {
      f.visitCandidate(cand);
    }
  }
  return null;
}

/** What the growth engine's weave gate reads (the Engine supplies it). */
export interface WeaveGateContext {
  /** The organic planner; absent in the legacy model, which never weaves. */
  readonly pacing?: EnginePacing;
  readonly settings: { readonly weaveEnabled: boolean };
  readonly unfollowFeed: {
    atDailyCap(now: number): boolean;
    nextCandidate(now: number): { pk: string; username: string } | null;
  };
}

/**
 * The next woven prune-unfollow candidate, or null. Only in the organic model with
 * `weaveEnabled`, a feed injected, and the prune daily cap not hit. Pure selection —
 * consumes only leading skips (whitelisted / followed-back-since / no-username).
 */
export function selectWovenCandidate(ctx: WeaveGateContext, now: number): { pk: string; username: string } | null {
  if (ctx.pacing === undefined || !ctx.settings.weaveEnabled) return null;
  const feed = ctx.unfollowFeed;
  if (feed.atDailyCap(now)) return null;
  return feed.nextCandidate(now);
}
