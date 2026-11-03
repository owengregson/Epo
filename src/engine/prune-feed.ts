/**
 * The woven prune feed's selection: the next actionable unfollow from the fresh
 * census, and the growth engine's gate on drawing from the feed at all.
 */

import type { ProtectionVerdict } from '../shared/unfollow-protection';
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
  /** The protection verdict over the candidate's stored facts, as they stand now. */
  protectionOf(cand: PruneCandidate): ProtectionVerdict;
  visitCandidate(cand: PruneCandidate): void;
}

/**
 * The next actionable unfollow, or null. Skips (consuming them) protected, followed-back-since and
 * no-username rows; null when the feed is halted, no fresh scan exists, the daily cap is hit, or
 * protection is paused (the feed yields to follows). The returned candidate is consumed on execute.
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
      protection: f.protectionOf(cand),
      followsUsNow: f.followsUsNow(cand.pk),
    });
    if (verdict.do === 'unfollow') return { pk: verdict.pk, username: verdict.username };
    if (verdict.do === 'stop') return null;
    // A permanent skip for this census: drop it and move on. `remaining`
    // tracks the ACTIONABLE census (protected rows already excluded), so a
    // protected skip consumes the durable row WITHOUT spending an actionable
    // slot — decrementing here would zero the count while actionable candidates still exist.
    pending.shift();
    if (verdict.reason === 'protected') {
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
 * consumes only leading skips (protected / followed-back-since / no-username).
 */
export function selectWovenCandidate(ctx: WeaveGateContext, now: number): { pk: string; username: string } | null {
  if (ctx.pacing === undefined || !ctx.settings.weaveEnabled) return null;
  const feed = ctx.unfollowFeed;
  if (feed.atDailyCap(now)) return null;
  return feed.nextCandidate(now);
}
