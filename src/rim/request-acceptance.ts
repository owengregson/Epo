/**
 * The requests panel's accept pass: journal and verify each request separately, never replay a
 * dispatched unknown. A registered accept settles its intent with the follower edge, which closes the
 * requester's open `requests` edge in the same write (spec §9.4 step 7).
 */

import { ActionBlockedError } from '@/adapter/errors';
import type { TempoSource } from '@/kernel/tempo';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import { sample } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import type { AcceptedFollowRequest, NotificationsActor } from './feed-source';

export interface AcceptPassDeps {
  readonly actor: NotificationsActor;
  /** The accept journal; without it (and the own pk) nothing is journaled. */
  readonly store?: KnowledgeStore;
  readonly ownPk?: string;
  readonly canAccept?: () => Promise<boolean>;
  readonly onAccepted?: () => void;
  /** At most this many accepts in the pass (the plan's allowance). */
  readonly cap: number;
  readonly acceptVerifyMs: number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly tempo: TempoSource;
  readonly now: () => number;
}

/** Accept the panel's head rows, one verified click at a time; `onAccept` hears each the moment it registered. */
export async function acceptRequests(d: AcceptPassDeps, pendingPks: Map<string, string>,
  onAccept: (a: AcceptedFollowRequest) => void, signal: AbortSignal | undefined): Promise<void> {
  for (let i = 0; i < d.cap; i++) {
    if (signal?.aborted) return;
    const before = await d.actor.probeFollowRequestHead();
    if (!before.found) return; // no rows left (or panel gone)
    if (d.canAccept && !(await d.canAccept())) return;
    const pkBefore = before.username ? pendingPks.get(before.username.toLowerCase()) ?? null : null;
    // An unresolved row cannot be safely journaled or distinguished after a crash.
    if (d.ownPk && d.store && pkBefore === null) return;
    const intent = d.store && d.ownPk && pkBefore && before.username
      ? d.store.beginEffectIntent({ accountPk: pkBefore, username: before.username,
        action: 'accept-request', channel: 'accept-request', at: d.now() }) : null;
    if (intent && intent.state !== 'prepared') return;
    let click: Awaited<ReturnType<NotificationsActor['confirmNextFollowRequest']>>;
    try {
      click = await d.actor.confirmNextFollowRequest(async (username) => {
        if (signal?.aborted || (d.canAccept && !await d.canAccept())) throw new ActionBlockedError('accept-request', 'admission changed');
        if (intent) {
          if (username?.toLowerCase() !== intent.username.toLowerCase()) throw new ActionBlockedError('accept-request', 'request row changed');
          d.store?.markEffectDispatched(intent.id, d.now());
        }
      });
    } catch (error) {
      if (intent) {
        if (d.store?.getEffectIntent(intent.id)?.state === 'dispatched') d.store.markEffectUncertain(intent.id, d.now());
        else d.store?.settleEffectIntent(intent.id, { at: d.now(), result: 'cancelled' });
      }
      throw error;
    }
    if (!click.clicked) {
      if (intent) d.store?.settleEffectIntent(intent.id, { at: d.now(), result: 'cancelled' });
      return;
    }

    // Verify the click consumed its row before counting it.
    let progressed = false;
    const deadline = d.now() + d.acceptVerifyMs;
    for (;;) {
      const after = await d.actor.probeFollowRequestHead();
      if (
        !after.found ||
        (after.remaining ?? 0) < (before.remaining ?? 1) ||
        (after.username != null && before.username != null && after.username !== before.username)
      ) {
        progressed = true;
        break;
      }
      if (d.now() >= deadline) break;
      await d.sleep(RIM.ACCEPT_VERIFY_POLL_MS, signal);
    }
    if (!progressed) {
      if (intent) d.store?.markEffectUncertain(intent.id, d.now());
      logger.warn('rim.follow-notifications: accept click did not register, stopping loop', {
        username: click.username,
      });
      return;
    }
    if (intent && d.ownPk) d.store?.settleEffectIntent(intent.id, {
      at: d.now(), result: 'ok', ledger: 'none',
      edge: { srcPk: intent.accountPk, dstPk: d.ownPk, active: true },
    });
    d.onAccepted?.();

    const username = click.username ?? before.username ?? null;
    if (username === null) {
      logger.warn('rim.follow-notifications: accepted a request but the row had no username');
    } else {
      const pk = pendingPks.get(username.toLowerCase()) ?? d.store?.pkByUsername(username) ?? null;
      onAccept({ pk, username });
      logger.info('rim.follow-notifications: accepted follow request', { username, pk });
    }

    await d.sleep(sample(d.tempo.policy('gap.accept')), signal);
  }
  logger.info('rim.follow-notifications: accept cap reached, remainder next check', { cap: d.cap });
}
