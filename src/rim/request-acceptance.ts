import { ActionBlockedError } from '@/adapter/errors';
import type { TempoSource } from '@/kernel/tempo';
import { RIM } from '@/timing/config';
import { sample } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import type { AcceptedFollowRequest, FollowNotificationsDeps, NotificationsActor } from './follow-notifications';

/** Journal and verify each request separately; never replay a dispatched unknown. */
export async function acceptRequests(d: Pick<FollowNotificationsDeps, 'actor' | 'store' | 'ownPk' | 'canAccept' | 'onAccepted'> & {
  acceptVerifyMs: number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; tempo: TempoSource;
}, pendingPks: Map<string, string>, accepted: AcceptedFollowRequest[], signal: AbortSignal | undefined): Promise<void> {
    for (let i = 0; i < RIM.REQUEST_ACCEPT_CAP; i++) {
      if (signal?.aborted) return;
      const before = await d.actor.probeFollowRequestHead();
      if (!before.found) return; // no rows left (or panel gone)
      if (d.canAccept && !(await d.canAccept())) return;
      const pkBefore = before.username ? pendingPks.get(before.username.toLowerCase()) ?? null : null;
      // An unresolved row cannot be safely journaled or distinguished after a crash.
      if (d.ownPk && d.store && pkBefore === null) return;
      const intent = d.store && d.ownPk && pkBefore && before.username
        ? d.store.beginEffectIntent({ accountPk: pkBefore, username: before.username,
          action: 'accept-request', channel: 'accept-request', at: Date.now() }) : null;
      if (intent && intent.state !== 'prepared') return;
      let click: Awaited<ReturnType<NotificationsActor['confirmNextFollowRequest']>>;
      try {
        click = await d.actor.confirmNextFollowRequest(async (username) => {
          if (signal?.aborted || (d.canAccept && !await d.canAccept())) throw new ActionBlockedError('accept-request', 'admission changed');
          if (intent) {
            if (username?.toLowerCase() !== intent.username.toLowerCase()) throw new ActionBlockedError('accept-request', 'request row changed');
            d.store?.markEffectDispatched(intent.id, Date.now());
          }
        });
      } catch (error) {
        if (intent) {
          if (d.store?.getEffectIntent(intent.id)?.state === 'dispatched') d.store.markEffectUncertain(intent.id, Date.now());
          else d.store?.settleEffectIntent(intent.id, { at: Date.now(), result: 'cancelled' });
        }
        throw error;
      }
      if (!click.clicked) {
        if (intent) d.store?.settleEffectIntent(intent.id, { at: Date.now(), result: 'cancelled' });
        return;
      }

      // Verify the click consumed its row before counting it.
      let progressed = false;
      const deadline = Date.now() + d.acceptVerifyMs;
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
        if (Date.now() >= deadline) break;
        await d.sleep(RIM.ACCEPT_VERIFY_POLL_MS, signal);
      }
      if (!progressed) {
        if (intent) d.store?.markEffectUncertain(intent.id, Date.now());
        logger.warn('rim.follow-notifications: accept click did not register, stopping loop', {
          username: click.username,
        });
        return;
      }
      if (intent && d.ownPk) d.store?.settleEffectIntent(intent.id, {
        at: Date.now(), result: 'ok', ledger: 'none',
        edge: { srcPk: intent.accountPk, dstPk: d.ownPk, active: true },
      });
      d.onAccepted?.();

      const username = click.username ?? before.username ?? null;
      if (username === null) {
        logger.warn('rim.follow-notifications: accepted a request but the row had no username');
      } else {
        const pk =
          pendingPks.get(username.toLowerCase()) ?? d.store?.pkByUsername(username) ?? null;
        accepted.push({ pk, username });
        logger.info('rim.follow-notifications: accepted follow request', { username, pk });
      }

      await d.sleep(sample(d.tempo.policy('gap.accept')), signal);
    }
    logger.info('rim.follow-notifications: accept cap reached, remainder next check', {
      cap: RIM.REQUEST_ACCEPT_CAP,
    });
}
