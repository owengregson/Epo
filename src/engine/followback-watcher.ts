import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';
import { MS_PER_DAY } from '../timing/units';
import { info, warn } from '../utils/logger';

/** One "started following you" event, as the notifications source reports it. */
export interface FollowbackEvent {
  pk: string;
  username: string | null;
  /** Event time in epoch ms when the feed carried one; `null` otherwise. */
  atMs: number | null;
}

/** One follow request the source ACCEPTED (they follow us as of the accept). */
export interface FollowbackAccepted {
  pk: string | null;
  username: string;
}

/**
 * The follow-back watcher's Instagram source: one bounded read of the RECENT
 * "started following you" events (the live implementation clicks the
 * notifications drawer and parses the observed news-inbox response), plus —
 * when `acceptRequests` is passed — the drawer's "Follow requests" subtab,
 * auto-accepting pending requests (a PRIVATE account's follow-backs arrive as
 * requests and never surface as follow events until accepted). A failed read
 * is `ok: false` — never an empty success, so "nobody followed back" and
 * "could not read" stay distinguishable. Tests inject a scripted fake.
 */
export interface FollowbackNotifications {
  fetchRecent(opts?: { acceptRequests?: boolean }): Promise<{
    ok: boolean;
    events: FollowbackEvent[];
    accepted?: FollowbackAccepted[];
    reason?: string;
  }>;
}

/** Tunable knobs for the Follow-back Watcher. Exposed in Settings. */
export interface FollowbackConfig {
  /** How long to hold a reciprocated follow before it can be unfollowed. Sets `holdUntil`. */
  holdAfterFollowbackMs: number;
  /**
   * Auto-accept incoming follow requests during each check (private accounts:
   * a requester is a follow-back the moment we accept). The source soft-skips
   * when no requests entry exists, so this is free for public accounts.
   */
  autoAcceptRequests: boolean;
}

/** Design defaults: 2-day hold; requests auto-accepted. */
export const FOLLOWBACK_DEFAULTS: FollowbackConfig = {
  holdAfterFollowbackMs: 2 * MS_PER_DAY,
  autoAcceptRequests: true,
};

interface FollowbackDeps {
  store: KnowledgeStore;
  clock: Clock;
  /** Our own account PK — the destination of every "follows us" edge. */
  ownPk: string;
  notifications: FollowbackNotifications;
  cfg?: FollowbackConfig;
}

/**
 * Follow-back detection via the NOTIFICATIONS feed (v4): reading "who followed
 * me?" from the notifications drawer — one click on the bell, one observed news-inbox
 * response — instead of paging the whole own-followers list. One request per
 * check makes an hourly cadence affordable (the old paged sweep budgeted for
 * multi-hour gaps).
 *
 * Order of resolution per check:
 *  1. Nothing pending → no request at all (request-minimal).
 *  2. ZERO-REQUEST pass: knowledge already in the graph decides first — a
 *     prune census (or any observed source) may have recorded the follow-back
 *     edge since the last check.
 *  3. One notifications read. Every follow event records a follows-us edge at
 *     the EVENT's own timestamp (an old notification must not chart as
 *     today's gain), and pending records seen in the feed transition to
 *     `followed_back` with the hold anchored at the event time — a follow
 *     that happened days ago has already served that much of its hold.
 *
 * Misses are covered by the layers around this: the census pass above, and the
 * scheduler's `maxWaitForFollowback` timeout reclaiming non-reciprocated slots.
 */
export class FollowbackWatcher {
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly ownPk: string;
  private readonly notifications: FollowbackNotifications;
  private cfg: FollowbackConfig;

  constructor(deps: FollowbackDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ownPk = deps.ownPk;
    this.notifications = deps.notifications;
    this.cfg = deps.cfg ?? FOLLOWBACK_DEFAULTS;
  }

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: FollowbackConfig): void {
    this.cfg = cfg;
  }

  /** Transition one pending record to followed_back, holding from `at`. */
  private markFollowedBack(pk: string, at: number, detected: string[]): void {
    const rec = this.store.getFollowRecord(pk);
    if (rec === null) return;
    // The hold never anchors before OUR follow: a feed event can predate it
    // (they followed us first, we followed them later) and an unfollow moments
    // after our own follow reads as churn to any observer.
    const anchor = Math.max(at, rec.followedAt ?? at);
    this.store.upsertFollowRecord({
      ...rec,
      state: 'followed_back',
      followedBackAt: anchor,
      holdUntil: anchor + this.cfg.holdAfterFollowbackMs,
    });
    detected.push(pk);
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

    // 2. ZERO-REQUEST pass: knowledge already in the graph decides first.
    {
      const now = this.clock.now();
      for (const pk of [...pending]) {
        const edge = this.store.getEdge(pk, this.ownPk, 'follows');
        if (edge !== null && edge.status === 'active') {
          this.markFollowedBack(pk, now, detected);
          pending.delete(pk);
        }
      }
      if (pending.size === 0) return { detected };
    }

    // 3. One notifications pass (inbox events + optional request-accepting).
    const result = await this.notifications.fetchRecent({
      acceptRequests: this.cfg.autoAcceptRequests,
    });
    if (!result.ok) {
      warn('followback: notifications read failed, skipping check', {
        reason: result.reason,
      });
      return { detected };
    }

    const now = this.clock.now();
    for (const event of result.events) {
      // Clamp future/garbage feed timestamps; an absent one means "recently".
      const at = event.atMs !== null && event.atMs <= now ? event.atMs : now;
      // FACTS STREAM (docs/PRINCIPLES.md §1): everything this event carries is
      // stored per event — the username the feed named (a real accounts row for
      // free) and the follows-us edge at the EVENT time (idempotent; the store
      // preserves first_seen_at) so net-growth charts the follow on the day it
      // actually happened, not the day we read the feed.
      if (event.username !== null) {
        this.store.observe({
          accountPk: event.pk,
          observedAt: at,
          source: 'activity-feed',
          fields: { username: event.username },
        });
      }
      this.store.observeEdge(event.pk, this.ownPk, 'follows', true, at);
      if (pending.has(event.pk)) {
        this.markFollowedBack(event.pk, at, detected);
        pending.delete(event.pk);
      }
    }
    // 4. ACCEPTED follow requests: the requester follows us the moment the
    //    accept landed — record the fact and resolve any pending record. A
    //    request needs no feed event to count (private-account oversight fix).
    for (const acc of result.accepted ?? []) {
      if (acc.pk === null) {
        warn('followback: accepted a request but its pk is unresolved', {
          username: acc.username,
        });
        continue;
      }
      this.store.observe({
        accountPk: acc.pk,
        observedAt: now,
        source: 'friend-requests',
        fields: { username: acc.username },
      });
      this.store.observeEdge(acc.pk, this.ownPk, 'follows', true, now);
      if (pending.has(acc.pk)) {
        this.markFollowedBack(acc.pk, now, detected);
        pending.delete(acc.pk);
      }
    }

    if (detected.length > 0) {
      info('followback: detected follow-backs from notifications', {
        detected: detected.length,
        stillPending: pending.size,
      });
    }

    return { detected };
  }
}
