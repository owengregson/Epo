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

import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import type { Actor } from '@/adapter/actor';
import type { LocateConfirmRequestResult } from '@/adapter/ig-surface';
import type { FollowEvent, Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { ReadBudget } from '@/governors/read-budget';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { awaitCaptured, captureFeed } from '@/rim/feed-capture';
import type { RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import { sample, sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import { acceptRequests as acceptPendingRequests } from './request-acceptance';

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
  retryAt?: number;
  pendingRequestPks?: string[];
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
  confirmNextFollowRequest(onDispatch?: (username: string | null) => void | Promise<void>): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }>;
  /** Read the requests panel's head WITHOUT clicking — the accept-progress probe. */
  probeFollowRequestHead(): Promise<LocateConfirmRequestResult>;
}

export interface FollowNotificationsDeps {
  readBudget?: ReadBudget;
  ownPk?: string;
  canAccept?: () => Promise<boolean>;
  onAccepted?: () => void;
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
  /** The tempo the drawer's waits and step pauses resolve from (default: the reference tempo). */
  tempo?: TempoSource;
}

export class AdapterBackedFollowNotifications implements FollowNotificationsSource {
  private readonly readBudget?: ReadBudget;
  private readonly ownPk?: string;
  private readonly canAccept?: () => Promise<boolean>;
  private readonly onAccepted?: () => void;
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
  private readonly tempo: TempoSource;

  constructor(deps: FollowNotificationsDeps) {
    this.readBudget = deps.readBudget;
    this.ownPk = deps.ownPk;
    this.canAccept = deps.canAccept;
    this.onAccepted = deps.onAccepted;
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
    this.tempo = tempoOrReference(deps.tempo);
  }

  async fetchRecent(opts?: { acceptRequests?: boolean }): Promise<FollowNotificationsResult> {
    const permit = this.readBudget?.consume('notification', 'reconciliation');
    if (permit && !permit.allowed) {
      return { ok: false, events: [], accepted: [], reason: 'read-budget', retryAt: permit.resumeAt ?? undefined };
    }
    const status = await this.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.follow-notifications: sentinel non-ok, skipping check', { status });
      return { ok: false, events: [], accepted: [], reason: `sentinel:${status}` };
    }

    this.reporter.report({ kind: 'page', op: { op: 'check-notifications' } });
    try {
      return await this.fetchRecentHeld(opts?.acceptRequests === true);
    } finally {
      this.reporter.clear();
    }
  }

  private async fetchRecentHeld(acceptRequests: boolean): Promise<FollowNotificationsResult> {
    const { captured, seenEvents, pendingReads, unsubscribe } = captureFeed({
      tab: this.tab,
      reader: this.reader,
      store: this.store,
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
      await this.stepPause(signal);
      const filtered = await this.actor.clickNotificationsFollowsFilter();
      if (!filtered) {
        logger.debug('rim.follow-notifications: Follows filter not present, reading full feed');
      }

      // A drifted page also unblocks the wait: the response ARRIVED, so there is
      // nothing left to wait for — but only a well-formed page may count as data.
      await this.awaitCaptured(() => captured.events !== null || captured.feedDrift, pendingReads, signal);

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
        await this.sleep(sample(this.tempo.policy('scroll.wait.drawer')), signal);
        await Promise.all(pendingReads.splice(0));
        if (seenEvents.size === before) break; // no older page / nothing new
      }
      const events = captured.events;

      // --- Follow requests (private accounts) — same drawer session ---------
      const accepted: AcceptedFollowRequest[] = [];
      if (acceptRequests && !signal?.aborted) {
        await this.stepPause(signal);
        const entered = await this.actor.clickFollowRequestsEntry();
        if (entered) {
          await this.awaitCaptured(() => captured.pendingPks !== null, pendingReads, signal);
          await acceptPendingRequests({ actor: this.actor, store: this.store, ownPk: this.ownPk,
            canAccept: this.canAccept, onAccepted: this.onAccepted, acceptVerifyMs: this.acceptVerifyMs,
            sleep: this.sleep, tempo: this.tempo }, captured.pendingPks ?? new Map(), accepted, signal);
        } else {
          logger.debug('rim.follow-notifications: no Follow requests entry (nothing pending)');
        }
      }

      logger.info('rim.follow-notifications: pass complete', {
        events: events.length,
        accepted: accepted.length,
      });
      const acceptedPks = new Set(accepted.map((r) => r.pk));
      const pendingRequestPks = [...(captured.pendingPks?.values() ?? [])].filter((pk) => !acceptedPks.has(pk));
      return { ok: true, events, accepted, pendingRequestPks,
        retryAt: this.store?.getActionDelayDeadline() ?? undefined };
    } finally {
      unsubscribe();
      // Leave the drawer through its own X control — so the tab is
      // genuinely neutral for whatever acts next; fall back to toggling the
      // bell when no close control is found. Best-effort: every subsequent
      // operation begins with a `goto` that resets the SPA anyway.
      try {
        await this.sleep(sample(this.tempo.policy('drawer.close-settle')), this.abortSignal?.());
        const closed = await this.actor.clickNotificationsClose();
        if (!closed) await this.actor.clickNotifications();
      } catch (e) {
        logger.debug('rim.follow-notifications: drawer close skipped', { error: String(e) });
      }
    }
  }

  /** A reading pause between two presses of one drawer flow (`ui.step-pause`; off at identity). */
  private async stepPause(signal: AbortSignal | undefined): Promise<void> {
    if (this.tempo.enabled('ui.step-pause')) await this.sleep(sample(this.tempo.policy('ui.step-pause')), signal);
  }

  /** Bounded poll for an observed response (interruptible by a stop()). */
  private awaitCaptured(
    done: () => boolean,
    pendingReads: Promise<void>[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return awaitCaptured(done, pendingReads, signal, this.responseWaitMs, (ms, s) => this.sleep(ms, s));
  }
}
