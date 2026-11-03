import type { Clock } from '../governors/clock';
import type { KnowledgeStore } from '../store/knowledge-store';
import type { FollowRecord } from '../store/types';
import { MS_PER_DAY } from '../timing/units';
import { info, warn } from '../utils/logger';
import { FOLLOWBACK_DEFAULTS, type FollowbackCensus, type FollowbackCheckResult, type FollowbackConfig, type FollowbackNotifications, type FollowbackRelationships, RELATIONSHIP_FRESH_MS } from './followback-types';
import { reconcileFollowbackCohort } from './reconcile-followback-cohort';

export type { FollowbackAccepted, FollowbackCensus, FollowbackCheckResult, FollowbackConfig, FollowbackEvent, FollowbackNotifications, FollowbackRelationships } from './followback-types';
export { FOLLOWBACK_DEFAULTS, RELATIONSHIP_FRESH_MS } from './followback-types';

interface FollowbackDeps {
  store: KnowledgeStore;
  clock: Clock;
  /** Our own account PK — the destination of every "follows us" edge. */
  ownPk: string;
  notifications: FollowbackNotifications;
  cfg?: FollowbackConfig;
  followers?: FollowbackCensus;
  relationships?: FollowbackRelationships;
  signal?: () => AbortSignal | undefined;
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
  private readonly followers?: FollowbackCensus;
  private readonly relationships?: FollowbackRelationships;
  private readonly signal?: () => AbortSignal | undefined;
  /** The last check ended mid-sequence: the feed was read when the sequence began. */
  private continuing = false;

  constructor(deps: FollowbackDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.ownPk = deps.ownPk;
    this.notifications = deps.notifications;
    this.cfg = deps.cfg ?? FOLLOWBACK_DEFAULTS;
    this.followers = deps.followers;
    this.relationships = deps.relationships;
    this.signal = deps.signal;
  }

  /** Swap the live config in place (used when Settings are updated at runtime). */
  applyConfig(cfg: FollowbackConfig): void {
    this.cfg = cfg;
  }

  /** Transition one pending record to followed_back, holding from `at`. */
  private markFollowedBack(pk: string, at: number | null, observedAt: number, detected: string[], evidenceAt: number | null = observedAt): void {
    const rec = this.store.getFollowRecord(pk);
    if (rec === null) return;
    // The hold never anchors before OUR follow: a feed event can predate it
    // (they followed us first, we followed them later) and an unfollow moments
    // after our own follow reads as churn to any observer.
    // Membership discovered after an absence is not a dated follow-back event.
    const anchor = Math.max(at ?? observedAt, rec.followedAt ?? 0);
    this.store.upsertFollowRecord({
      ...rec,
      state: 'followed_back',
      followedBackAt: at === null ? rec.followedBackAt : at,
      followbackObservedAt: observedAt,
      reconciledAt: evidenceAt === null ? rec.reconciledAt : evidenceAt,
      holdUntil: anchor + this.cfg.holdAfterFollowbackMs,
      unfollowDueAt: undefined,
      unfollowReason: undefined,
    });
    detected.push(pk);
  }

  /**
   * Detect which of our pending follows have followed us back, transitioning each to
   * `followed_back` with a hold timer. Returns the PKs newly detected this run.
   */
  async check(opts: { requireFresh?: boolean; freshSinceAt?: number } = {}): Promise<FollowbackCheckResult> {
    const detected: string[] = [];
    const continuing = this.continuing;
    this.continuing = false;
    const token = this.signal?.();
    const stopped = (): boolean => Boolean(token?.aborted || token !== this.signal?.());
    const startedAt = this.clock.now();
    this.store.ensureFollowersBaseline(startedAt);
    const cohort = this.store.activeFollowRecords().filter((r) => r.state !== 'queued');
    const cutoff = opts.requireFresh ? opts.freshSinceAt ?? startedAt : startedAt - RELATIONSHIP_FRESH_MS;
    const maxWait = this.cfg.maxWaitForFollowbackMs ?? 4 * MS_PER_DAY;
    const needsEvidence = (r: FollowRecord): boolean => Boolean(opts.requireFresh)
      || r.state === 'unfollow_queued'
      || (r.state === 'pending_followback' && r.followedAt !== undefined
        && startedAt - r.followedAt >= maxWait)
      || (r.state === 'followed_back' && r.holdUntil !== undefined && startedAt >= r.holdUntil);
    const currentCohort = (): FollowRecord[] => cohort.map((r) => this.store.getFollowRecord(r.accountPk))
      .filter((r): r is FollowRecord => r !== null && ['pending_followback', 'followed_back', 'unfollow_queued'].includes(r.state));
    const evidenceCutoff = (r: FollowRecord): number => r.state === 'pending_followback'
      && r.followedAt !== undefined && startedAt - r.followedAt >= maxWait
      ? Math.max(cutoff, r.followedAt + maxWait) : cutoff;
    const unresolvedRecords = (): FollowRecord[] => currentCohort().filter((r) => needsEvidence(r)
      && (r.reconciledAt === undefined || r.reconciledAt < evidenceCutoff(r) || r.reconciledAt > this.clock.now()));
    const unresolved = (): number => unresolvedRecords().length;
    const result = (outcome: FollowbackCheckResult['outcome']): FollowbackCheckResult => ({
      detected, outcome, reconciledAt: outcome === 'complete' ? this.clock.now() : null,
      unresolved: unresolved(),
    });
    const interrupted = (): FollowbackCheckResult => ({ ...result('partial'),
      deferred: 'reconciliation-progress', retryAt: this.clock.now() + 30_000 });
    const canDetect = (r: FollowRecord): boolean => r.state === 'pending_followback'
      || (r.state === 'unfollow_queued' && r.unfollowReason !== 'hold-expired'
        && r.followedBackAt === undefined && r.followbackObservedAt === undefined);
    const consumeCurrent = (): void => {
      for (const rec of currentCohort()) {
        const edge = this.store.getEdge(rec.accountPk, this.ownPk, 'follows');
        if (edge === null || edge.lastConfirmedAt < evidenceCutoff(rec) || edge.lastConfirmedAt > this.clock.now()) continue;
        if (edge.status === 'active' && canDetect(rec)) {
          this.markFollowedBack(rec.accountPk, null, this.clock.now(), detected, edge.lastConfirmedAt);
        } else {
          this.store.upsertFollowRecord({ ...rec, reconciledAt: edge.lastConfirmedAt });
        }
      }
    };

    if (stopped()) return interrupted();
    consumeCurrent();
    if (cohort.length === 0) return result('complete');
    // Known fresh memberships need no repeated read. A long return explicitly bypasses this shortcut.
    const pending = currentCohort().filter(canDetect);
    if (!opts.requireFresh && pending.length === 0 && unresolved() === 0) return result('complete');

    // A batch sequence that made progress continues with targeted reads only:
    // reopening the drawer before every batch of ten (live 2026-11-02) read the
    // same feed every ~45 s.
    let read: Awaited<ReturnType<FollowbackNotifications['fetchRecent']>> = { ok: true, events: [], accepted: [] };
    try {
      if (!continuing) read = await this.notifications.fetchRecent({ acceptRequests: this.cfg.autoAcceptRequests });
    } catch (e) {
      warn('followback: notifications read threw', { error: String(e) });
      return result(detected.length > 0 ? 'partial' : 'failed');
    }
    if (stopped()) return interrupted();
    if (!read.ok) {
      warn('followback: notifications read failed', { reason: read.reason });
      if (read.reason === 'read-budget') return {
        ...result('partial'), deferred: 'read-budget', retryAt: read.retryAt,
      };
      return result(detected.length > 0 ? 'partial' : 'failed');
    }
    const now = this.clock.now();
    for (const event of read.events) {
      const datedAt = event.atMs !== null && Number.isFinite(event.atMs)
        && event.atMs <= now ? event.atMs : null;
      const at = datedAt ?? now;
      if (event.username !== null) this.store.observe({
        accountPk: event.pk, observedAt: at, source: 'activity-feed', fields: { username: event.username },
      });
      // An undated feed item is historical evidence, not a current relationship check.
      if (datedAt !== null) this.store.observeOwnFollowerEvent(event.pk, this.ownPk, datedAt);
      const rec = this.store.getFollowRecord(event.pk);
      const edge = this.store.getEdge(event.pk, this.ownPk, 'follows');
      // Historical events enrich history but never contradict a later negative observation.
      if (rec !== null && canDetect(rec)
        && (datedAt === null ? edge?.status !== 'removed' : edge?.status === 'active')) {
        this.markFollowedBack(event.pk, datedAt, now, detected, datedAt);
      }
    }
    for (const acc of read.accepted ?? []) {
      if (acc.pk === null) {
        warn('followback: accepted request has no resolved pk', { username: acc.username });
        continue;
      }
      this.store.observe({ accountPk: acc.pk, observedAt: now, source: 'friend-requests', fields: { username: acc.username } });
      this.store.observeOwnFollowerEvent(acc.pk, this.ownPk, now, 'accept');
      const rec = this.store.getFollowRecord(acc.pk);
      if (rec !== null && canDetect(rec)) this.markFollowedBack(acc.pk, now, now, detected);
    }
    consumeCurrent();

    // A paced acceptance backlog is still being reconciled. Its observed requesters
    // are not followers yet, and a census must not turn that into an expiry verdict.
    const acceptedPks = new Set((read.accepted ?? []).map((a) => a.pk));
    const pendingRequests = new Set((read.pendingRequestPks ?? []).filter((pk) => !acceptedPks.has(pk)));
    if (this.cfg.autoAcceptRequests && currentCohort().some((r) => pendingRequests.has(r.accountPk))) {
      return { ...result('partial'), deferred: 'pending-requests',
        retryAt: read.retryAt ?? this.store.getActionDelayDeadline() ?? now + 3 * 60_000 };
    }

    if (unresolved() > 0 && this.relationships) {
      const batch = await reconcileFollowbackCohort({ store: this.store, clock: this.clock,
        ownPk: this.ownPk, relationships: this.relationships, records: unresolvedRecords(), signal: this.signal });
      if (stopped()) return interrupted();
      consumeCurrent();
      if (unresolved() > 0) {
        if (batch.outcome === 'read-budget') return { ...result('partial'), deferred: 'read-budget', retryAt: batch.retryAt };
        if (batch.outcome === 'progress') {
          // The shared profile visitor paces every read: continue at once.
          this.continuing = true;
          return { ...result('partial'), deferred: 'reconciliation-progress', retryAt: this.clock.now() };
        }
        return result('failed');
      }
    }
    // The whole-list census remains a fallback for callers without targeted reads.
    if (unresolved() > 0) {
      if (this.followers === undefined) return result('partial');
      let census: Awaited<ReturnType<FollowbackCensus['fetchAllPks']>>;
      try { census = await this.followers.fetchAllPks(); }
      catch (e) {
        warn('followback: reconciliation census failed', { error: String(e) });
        return result('partial');
      }
      if (stopped()) return interrupted();
      const observedAt = this.clock.now();
      const members = new Set(census.pks);
      for (const pk of members) this.store.observeEdge(pk, this.ownPk, 'follows', true, observedAt, { source: 'census' });
      const stats = this.store.getAccount(this.ownPk);
      const headerFresh = stats?.statsObservedAt !== undefined
        && stats.statsObservedAt >= startedAt - RELATIONSHIP_FRESH_MS && stats.statsObservedAt <= observedAt;
      const covered = census.authoritative === true || (headerFresh && stats?.followers !== undefined
        && members.size >= stats.followers * 0.98);
      if (census.complete && covered) {
        this.store.ingestScanCensus([], [...members], observedAt, {
          authoritative: { followers: true, following: false },
        });
        // An absent edge need not exist yet. Write explicit absence for each managed record.
        for (const rec of currentCohort()) {
          if (!members.has(rec.accountPk)) {
            this.store.observeEdge(rec.accountPk, this.ownPk, 'follows', false, observedAt, { source: 'census' });
          }
        }
      }
      consumeCurrent();
      if (!census.complete || !covered) return {
        ...result('partial'),
        ...(census.reason === 'read-budget' ? { deferred: 'read-budget' as const, retryAt: census.retryAt } : {}),
      };
    }
    if (detected.length > 0) info('followback: reconciled follow-backs', { detected: detected.length });
    return result(unresolved() === 0 ? 'complete' : 'partial');
  }
}
