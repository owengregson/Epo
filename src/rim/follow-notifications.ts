/**
 * AdapterBackedFollowNotifications — the follow-back watcher's live
 * notifications source.
 *
 * Instead of paging our whole followers list, the watcher reads Instagram
 * through its own "who followed me?" surface: click the NOTIFICATIONS control in
 * the nav rail, let the activity drawer fire its news-inbox fetch, and parse
 * the "started following you" events out of the observed response — one
 * click, one request, so the check is cheap enough to run hourly.
 *
 * PRIVATE-ACCOUNT REQUESTS (same drawer session): a private account's
 * follow-backs arrive as follow REQUESTS, which never show as "started
 * following you" until accepted. When `acceptRequests` is on, the pass also
 * clicks the drawer's "Follow requests" entry, observes the
 * friendships/pending response (every requester row is stored immediately —
 * facts stream, docs/PRINCIPLES.md §1), and accepts each request through the
 * real Confirm buttons — bounded per check, paced, and verified per click
 * (the head row must change before the next accept counts).
 *
 * A sentinel block, an unlocatable control, or a response that never arrives
 * is a TYPED failure (`ok: false` + reason), never an empty success — an
 * empty feed must remain distinguishable from a failed read.
 */

import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import type { Actor } from '@/adapter/actor';
import { type LocateConfirmRequestResult, SURFACE } from '@/adapter/ig-surface';
import type { FollowEvent, Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export type { FollowEvent } from '@/adapter/reader';

/** One follow request this pass ACCEPTED (they follow us as of now). */
export interface AcceptedFollowRequest {
  /** Resolved from the pending-list rows / store; null when unresolvable. */
  pk: string | null;
  username: string;
}

/** The outcome of one notifications pass. `events`/`accepted` meaningful when ok. */
export interface FollowNotificationsResult {
  ok: boolean;
  events: FollowEvent[];
  accepted: AcceptedFollowRequest[];
  reason?: string;
}

/** The port the follow-back watcher consumes (tests inject a scripted fake). */
export interface FollowNotificationsSource {
  fetchRecent(opts?: { acceptRequests?: boolean }): Promise<FollowNotificationsResult>;
}

/** The slice of the Actor this source drives. */
export interface NotificationsActor {
  clickNotifications(): Promise<boolean>;
  /** Soft niceties inside the open drawer — a `false` result is never fatal. */
  clickNotificationsFollowsFilter(): Promise<boolean>;
  clickNotificationsClose(): Promise<boolean>;
  scrollNotificationsList(): Promise<boolean>;
  clickFollowRequestsEntry(): Promise<boolean>;
  confirmNextFollowRequest(): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }>;
}

export interface FollowNotificationsDeps {
  tab: RimTab;
  actor: NotificationsActor | Actor;
  reader: Reader;
  sentinel: Sentinel;
  /** When supplied, pending-request rows are stored as they parse (§1). */
  store?: KnowledgeStore;
  /** How long to wait for an observed response after a click (default 10 s). */
  responseWaitMs?: number;
  /** How long an accept click may take to visibly consume its row (default 4 s). */
  acceptVerifyMs?: number;
  /** Injected for tests; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Provider of the ACTIVE driver's abort signal — a stop() ends the pass. */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
}

export class AdapterBackedFollowNotifications implements FollowNotificationsSource {
  private readonly tab: RimTab;
  private readonly actor: NotificationsActor;
  private readonly reader: Reader;
  private readonly sentinel: Sentinel;
  private readonly store?: KnowledgeStore;
  private readonly responseWaitMs: number;
  private readonly acceptVerifyMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: FollowNotificationsDeps) {
    this.tab = deps.tab;
    this.actor = deps.actor;
    this.reader = deps.reader;
    this.sentinel = deps.sentinel;
    this.store = deps.store;
    this.responseWaitMs = deps.responseWaitMs ?? RIM.NOTIFICATIONS_WAIT_MS;
    this.acceptVerifyMs = deps.acceptVerifyMs ?? RIM.ACCEPT_VERIFY_MS;
    this.sleep = deps.sleep ?? sleep;
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
  }

  async fetchRecent(opts?: { acceptRequests?: boolean }): Promise<FollowNotificationsResult> {
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.follow-notifications: sentinel non-ok, skipping check', { status });
      return { ok: false, events: [], accepted: [], reason: `sentinel:${status}` };
    }

    this.reporter.report({ kind: 'page', label: 'Checking notifications' });
    try {
      return await this.fetchRecentHeld(opts?.acceptRequests === true);
    } finally {
      this.reporter.clear();
    }
  }

  private async fetchRecentHeld(acceptRequests: boolean): Promise<FollowNotificationsResult> {
    // Capture the FIRST activity-feed response — and, when accepting, the
    // pending-requests response — that land after the clicks. Subscribing
    // BEFORE clicking closes the race where a fast response beats the handler.
    // (Object properties so callback assignments stay visible to CFA.)
    const captured: {
      /** Accumulated follow events across ALL observed WELL-FORMED feed pages (deduped). */
      events: FollowEvent[] | null;
      sawInbox: boolean;
      /** A feed body arrived but shape-mismatched (IG drift / fail interstitial). */
      feedDrift: boolean;
      /** username(lower) → pk from the observed pending-requests rows. */
      pendingPks: Map<string, string> | null;
    } = { events: null, sawInbox: false, feedDrift: false, pendingPks: null };
    const seenEvents = new Set<string>();
    const pendingReads: Promise<void>[] = [];
    const unsubscribe = this.tab.onResponse((resp) => {
      const kind = this.reader.matchEndpoint(resp.url);
      if (kind !== 'activity-feed' && kind !== 'friend-requests') return;
      if (kind === 'activity-feed') captured.sawInbox = true;
      pendingReads.push(
        resp
          .getBody()
          .then((body) => {
            if (kind === 'activity-feed') {
              // MERGE every observed feed page (the initial open, the Follows
              // filter refetch, scroll-loaded older pages) — deduped. STRICT
              // parse per page: a drifted body leaves `events` untouched (so
              // it can never read as a successful empty check) but flags the
              // drift; one well-formed page among drifted ones still succeeds.
              const parsed = this.reader.parseActivityFeedStrict(body);
              if (parsed === null) {
                captured.feedDrift = true;
                return;
              }
              const merged = captured.events ?? [];
              for (const e of parsed) {
                const key = `${e.pk}|${e.atMs ?? ''}`;
                if (seenEvents.has(key)) continue;
                seenEvents.add(key);
                merged.push(e);
              }
              captured.events = merged;
              return;
            }
            if (captured.pendingPks !== null) return;
            const parsed = this.reader.parsePendingRequests(body, Date.now());
            const map = new Map<string, string>();
            for (const obs of parsed.observations) {
              // §1: every requester row is a fact — store it as it parses.
              this.store?.observe(obs);
              if (typeof obs.fields.username === 'string') {
                map.set(obs.fields.username.toLowerCase(), obs.accountPk);
              }
            }
            captured.pendingPks = map;
          })
          .catch((e: unknown) => {
            logger.warn('rim.follow-notifications: response body read failed', {
              kind,
              error: String(e),
            });
          }),
      );
    });

    try {
      const clicked = await this.actor.clickNotifications();
      if (!clicked) {
        logger.warn('rim.follow-notifications: notifications control not located, skipping');
        return { ok: false, events: [], accepted: [], reason: 'control-not-located' };
      }
      const signal = this.abortSignal?.();

      // Narrow the feed to follow events with the drawer's own filter — a soft
      // nicety (the JSON parse filters by story type regardless of the UI filter).
      const filtered = await this.actor.clickNotificationsFollowsFilter();
      if (!filtered) {
        logger.debug('rim.follow-notifications: Follows filter not present, reading full feed');
      }

      // A drifted page also unblocks the wait: the response ARRIVED, so there is
      // nothing left to wait for — but only a well-formed page may count as data.
      await this.awaitCaptured(
        () => captured.events !== null || captured.feedDrift,
        pendingReads,
        signal,
      );

      if (signal?.aborted) return { ok: false, events: [], accepted: [], reason: 'aborted' };
      if (captured.events === null) {
        if (captured.feedDrift) {
          // Every observed feed body shape-mismatched: follow-back detection is
          // BROKEN by an IG change, not quiet — surface a loud, typed failure
          // (an empty success here would silently disable detection).
          logger.warn('rim.follow-notifications: activity feed shape drifted, failing check');
          return { ok: false, events: [], accepted: [], reason: 'feed-shape-drift' };
        }
        logger.warn('rim.follow-notifications: no activity-feed response after click', {
          sawResponse: captured.sawInbox,
          waitedMs: this.responseWaitMs,
        });
        return {
          ok: false,
          events: [],
          accepted: [],
          reason: captured.sawInbox ? 'body-unreadable' : 'no-response',
        };
      }

      // Bounded deepening: scroll the drawer list to pull older feed pages
      // (covers a backlog after downtime). Each round waits briefly for a new
      // page; a round that yields no NEW events ends the walk early.
      for (let round = 0; round < RIM.NOTIFICATIONS_SCROLL_ROUNDS; round++) {
        if (signal?.aborted) break;
        const before = seenEvents.size;
        const scrolled = await this.actor.scrollNotificationsList();
        if (!scrolled) break; // list fits or already bottomed
        await this.sleep(RIM.NOTIFICATIONS_SCROLL_WAIT_MS, signal);
        await Promise.all(pendingReads.splice(0));
        if (seenEvents.size === before) break; // no older page / nothing new
      }
      const events = captured.events;

      // --- Follow requests (private accounts) — same drawer session ---------
      const accepted: AcceptedFollowRequest[] = [];
      if (acceptRequests && !signal?.aborted) {
        const entered = await this.actor.clickFollowRequestsEntry();
        if (entered) {
          await this.awaitCaptured(() => captured.pendingPks !== null, pendingReads, signal);
          await this.acceptLoop(captured.pendingPks ?? new Map(), accepted, signal);
        } else {
          logger.debug('rim.follow-notifications: no Follow requests entry (nothing pending)');
        }
      }

      logger.info('rim.follow-notifications: pass complete', {
        events: events.length,
        accepted: accepted.length,
      });
      return { ok: true, events, accepted };
    } finally {
      unsubscribe();
      // Leave the drawer through its own X control — so the tab is
      // genuinely neutral for whatever acts next; fall back to toggling the
      // bell when no close control is found. Best-effort: every subsequent
      // operation begins with a `goto` that resets the SPA anyway.
      try {
        await this.sleep(RIM.NOTIFICATIONS_CLOSE_DELAY_MS, this.abortSignal?.());
        const closed = await this.actor.clickNotificationsClose();
        if (!closed) await this.actor.clickNotifications();
      } catch (e) {
        logger.debug('rim.follow-notifications: drawer close skipped', { error: String(e) });
      }
    }
  }

  /** Bounded poll for an observed response (interruptible by a stop()). */
  private async awaitCaptured(
    done: () => boolean,
    pendingReads: Promise<void>[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = Date.now() + this.responseWaitMs;
    while (!done() && Date.now() < deadline) {
      if (signal?.aborted) return;
      await this.sleep(RIM.NOTIFICATIONS_POLL_MS, signal);
      await Promise.all(pendingReads.splice(0));
    }
  }

  /**
   * Accept pending requests through the REAL Confirm buttons: bounded per
   * check, paced between clicks, and each accept VERIFIED — the head row must
   * visibly change (username/count) before it counts and the loop continues.
   * A click that doesn't register stops the loop (page problem, retry next
   * check) instead of hammering the same button.
   */
  private async acceptLoop(
    pendingPks: Map<string, string>,
    accepted: AcceptedFollowRequest[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const locate = SURFACE.locateConfirmFollowRequestScript;
    const probeHead = async (): Promise<LocateConfirmRequestResult> => {
      if (!locate) return { found: false };
      return this.tab.evaluate<LocateConfirmRequestResult>(locate());
    };

    for (let i = 0; i < RIM.REQUEST_ACCEPT_CAP; i++) {
      if (signal?.aborted) return;
      const before = await probeHead();
      if (!before.found) return; // no rows left (or panel gone)

      const click = await this.actor.confirmNextFollowRequest();
      if (!click.clicked) return;

      // Verify the click consumed its row before counting it.
      let progressed = false;
      const deadline = Date.now() + this.acceptVerifyMs;
      for (;;) {
        const after = await probeHead();
        if (
          !after.found ||
          (after.remaining ?? 0) < (before.remaining ?? 1) ||
          (after.username != null && before.username != null && after.username !== before.username)
        ) {
          progressed = true;
          break;
        }
        if (Date.now() >= deadline) break;
        await this.sleep(RIM.ACCEPT_VERIFY_POLL_MS, signal);
      }
      if (!progressed) {
        logger.warn('rim.follow-notifications: accept click did not register, stopping loop', {
          username: click.username,
        });
        return;
      }

      const username = click.username ?? before.username ?? null;
      if (username === null) {
        logger.warn('rim.follow-notifications: accepted a request but the row had no username');
      } else {
        const pk =
          pendingPks.get(username.toLowerCase()) ?? this.store?.pkByUsername(username) ?? null;
        accepted.push({ pk, username });
        logger.info('rim.follow-notifications: accepted follow request', { username, pk });
      }

      await this.sleep(
        sample(uniform(RIM.ACCEPT_PACE_MIN_MS, RIM.ACCEPT_PACE_MAX_MS)),
        signal,
      );
    }
    logger.info('rim.follow-notifications: accept cap reached, remainder next check', {
      cap: RIM.REQUEST_ACCEPT_CAP,
    });
  }
}
