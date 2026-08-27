/**
 * Relationship reconciliation (Phase A) — heal external follow/unfollow drift.
 *
 * The engine is NOT the only actor on the account's follow graph: the user (or
 * another tool) can follow/unfollow outside Epo, silently diverging
 * `follow_records`/`edges` from reality. Instagram's own responses already
 * carry the truth — `show_many` / `friendships/show` / `web_profile_info`
 * bodies report whether WE currently follow each account — so this subscribes
 * to the tab's response pipeline and feeds every such fact into the store's
 * single policy sink (`reconcileOwnFollow`, leave-alone policy: Epo only ever
 * unfollows accounts IT followed; an externally-owned relationship drops the
 * record to the terminal `external` state).
 *
 * Purely passive: it issues no requests and clicks nothing — it only parses
 * bodies the tab already captured. Install it ONCE at build alongside
 * `installRequestMetering`; ingest failures warn (never throw, never silently).
 */

import type { Reader } from '@/adapter/reader';
import type { Clock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { TabResponse, Unsubscribe } from '@/types';
import * as logger from '@/utils/logger';

export class RelationshipReconciler {
  private readonly store: KnowledgeStore;
  private readonly ownPk: string;
  private readonly reader: Reader;
  private readonly clock: Clock;

  constructor(deps: { store: KnowledgeStore; ownPk: string; reader: Reader; clock: Clock }) {
    this.store = deps.store;
    this.ownPk = deps.ownPk;
    this.reader = deps.reader;
    this.clock = deps.clock;
  }

  /**
   * Cheap pre-check for the passive install: does this URL carry viewer-side
   * relationship facts at all? Gating on "any known endpoint" used to pay a
   * full CDP body read + JSON.parse for every followers/following page a
   * 200-page walk fetched — all of which parse to zero facts here.
   */
  matches(url: string): boolean {
    return this.reader.relationshipBearing(url);
  }

  /**
   * Read one captured response's body and reconcile every relationship fact it
   * carries. A body that is gone from the CDP cache (or fails to parse) is a
   * WARN-and-skip — a missed observation, never an error state.
   */
  async ingest(resp: TabResponse): Promise<void> {
    let body: string;
    try {
      body = await resp.getBody();
    } catch (e) {
      logger.warn('rim.relationship-reconciler: body unavailable, skipping', {
        url: resp.url,
        error: String(e),
      });
      return;
    }
    try {
      const at = this.clock.now();
      for (const { pk, weFollow } of this.reader.relationshipFacts(resp.url, body, at)) {
        if (pk === this.ownPk) continue; // never reconcile our own account
        this.store.reconcileOwnFollow(pk, weFollow, at);
      }
    } catch (e) {
      logger.warn('rim.relationship-reconciler: reconciliation failed', {
        url: resp.url,
        error: String(e),
      });
    }
  }
}

/**
 * Subscribe the reconciler to the tab's responses. Returns an unsubscribe
 * disposer; call it on teardown so the handler does not outlive the tab.
 */
export function installRelationshipReconciler(
  tab: RimTab,
  reconciler: RelationshipReconciler,
): Unsubscribe {
  const unsubscribe = tab.onResponse((resp) => {
    // Only pay the async body read for URLs the Reader recognizes.
    if (reconciler.matches(resp.url)) void reconciler.ingest(resp);
  });
  logger.debug('rim.relationship-reconciler installed');
  return unsubscribe;
}
