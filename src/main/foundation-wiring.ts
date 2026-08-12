/**
 * Foundation wiring — the Phase 1 composition root.
 *
 * This is where the four independently-built pieces of the foundation meet:
 *
 *   embedded tab  ──▶  Instagram Adapter (Reader / Actor / Sentinel)
 *                          │
 *                          ▼
 *                    KnowledgeStore  ◀──  Governors (rate cap + request budget)
 *
 * The IPC handlers (`src/main/ipc.ts`) delegate straight to the async methods on
 * `Foundation`. Nothing here touches SQL (that stays behind `KnowledgeStore`) or
 * the DOM (that stays behind the Actor). All failures are logged AND surfaced as
 * typed results — never a silent `catch {}`.
 */

import { app, session } from 'electron';
import * as path from 'path';

import { InstagramTab, IG_HOME_URL, IG_PARTITION } from '@/adapter/tab';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Reader } from '@/adapter/reader';
import { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock, type Clock } from '@/governors/clock';
import { RateGovernor, type RateGovernorConfig } from '@/governors/rate-governor';
import { RequestBudget, type RequestBudgetConfig } from '@/governors/request-budget';
import type { Observation } from '@/store/types';
import type { Result } from '@/utils/result';
import * as logger from '@/utils/logger';
import type {
  ActionResult,
  FoundationStatus,
  ReadFollowersResult,
} from '@/types';

// --- Safety defaults (Global Constraints §9) --------------------------------
// These are the durable ceilings the whole foundation is gated behind. They
// become Settings values in Phase 3; for the gate they live here as constants.

const RATE_GOVERNOR_DEFAULTS: RateGovernorConfig = {
  dailyHardCeiling: 50,
  dailyOperatingRate: 25,
  minDelayMs: 180_000,
  maxDelayMs: 420_000,
  jitterPercent: 30,
  activeHoursStart: 8,
  activeHoursEnd: 22,
};

const REQUEST_BUDGET_DEFAULTS: RequestBudgetConfig = {
  maxRequestsPerWindow: 200,
  windowMs: 3_600_000,
};

/** Bounded followers-scroll loop tuning (readFollowers). */
const READ_FOLLOWERS = {
  /** Hard cap on scroll rounds so a live read is always bounded. */
  maxPages: 5,
  /** Pause after each scroll so the paginated `followers/` request lands. */
  scrollWaitMs: 2000,
  /** Stop after this many consecutive rounds that yield no new accounts. */
  stagnantLimit: 2,
} as const;

const IG_DB_FILE = 'peanut.db';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A small, case-insensitive username → numeric-pk memory, populated from parsed
 * observations. Account identity is the pk (never the username), so ledger
 * entries and edges prefer the pk; callers fall back to the username as the key
 * only when the pk has not yet been observed.
 */
export class PkRegistry {
  private readonly byUsername = new Map<string, string>();

  remember(username: string | undefined, pk: string): void {
    if (!username) return;
    this.byUsername.set(username.toLowerCase(), pk);
  }

  lookup(username: string): string | null {
    return this.byUsername.get(username.toLowerCase()) ?? null;
  }
}

export interface FoundationDeps {
  tab: InstagramTab;
}

export class Foundation {
  private readonly tab: InstagramTab;
  private readonly store: KnowledgeStore;
  private readonly clock: Clock;
  private readonly rateGovernor: RateGovernor;
  private readonly requestBudget: RequestBudget;
  private readonly adapter: InstagramAdapter;
  private readonly reader: Reader;
  private readonly pks = new PkRegistry();
  private ownPkCache: string | null = null;

  constructor(deps: FoundationDeps) {
    this.tab = deps.tab;
    this.store = new KnowledgeStore(
      path.join(app.getPath('userData'), IG_DB_FILE),
    );
    this.clock = new SystemClock();
    this.rateGovernor = new RateGovernor(
      this.store,
      this.clock,
      RATE_GOVERNOR_DEFAULTS,
    );
    this.requestBudget = new RequestBudget(
      this.store,
      this.clock,
      REQUEST_BUDGET_DEFAULTS,
    );
    this.adapter = new InstagramAdapter(this.tab);
    this.reader = new Reader();
    // Wire the REAL Reader into the facade's optional slot.
    this.adapter.reader = this.reader;
    logger.info('foundation ready', { adapterVersion: this.adapter.adapterVersion });
  }

  // -------------------------------------------------------------------------
  // Login / identity
  // -------------------------------------------------------------------------

  /** Open Instagram in the embedded tab; the user completes login there. */
  async login(): Promise<FoundationStatus> {
    this.tab.show();
    await this.tab.goto(IG_HOME_URL);
    return this.status();
  }

  /**
   * The logged-in account's numeric pk, read from the persistent session's
   * `ds_user_id` cookie (that value IS the account pk). Cached once resolved.
   */
  async ownPk(): Promise<string | null> {
    if (this.ownPkCache) return this.ownPkCache;
    try {
      const cookies = await session
        .fromPartition(IG_PARTITION)
        .cookies.get({ name: 'ds_user_id' });
      const cookie = cookies.find((c) => c.value.length > 0);
      if (cookie) {
        this.ownPkCache = cookie.value;
        return cookie.value;
      }
      return null;
    } catch (e) {
      logger.warn('foundation.ownPk: cookie read failed', { error: String(e) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Read a target's followers into the knowledge graph.
   *
   * Registers a response interceptor that, for each followers-list page the tab
   * captures, parses observations and writes them via `store.observe(...)`. The
   * target's own pk is resolved best-effort from the `web_profile_info` response
   * that fires on profile nav; once known, a `follower → target (follows)` edge
   * is recorded for every observed follower. A bounded scroll loop drives the
   * pagination, gated by the request budget, and stops on the page cap or when
   * no new accounts arrive for two consecutive rounds.
   */
  async readFollowers(target: string): Promise<ReadFollowersResult> {
    const sentinel = await this.adapter.sentinel.check();
    if (sentinel !== 'ok') {
      logger.warn('foundation.readFollowers: sentinel blocked', { target, sentinel });
      return { target, observed: 0 };
    }

    const observedPks = new Set<string>();
    const edgedPks = new Set<string>();
    const pending: Promise<void>[] = [];
    let targetPk: string | null = null;

    const linkEdge = (followerPk: string): void => {
      if (targetPk && !edgedPks.has(followerPk)) {
        edgedPks.add(followerPk);
        this.store.observeEdge(followerPk, targetPk, 'follows', true, this.clock.now());
      }
    };

    const unsubscribe = this.tab.onResponse((resp) => {
      const kind = this.reader.matchEndpoint(resp.url);
      if (kind !== 'followers-list' && kind !== 'profile-info') return;
      pending.push(
        resp
          .getBody()
          .then((body) => {
            if (kind === 'profile-info') {
              const obs = this.reader.parseProfileInfo(body, this.clock.now());
              if (!obs) return;
              this.remember(obs);
              this.store.observe(obs);
              if (
                obs.fields.username &&
                obs.fields.username.toLowerCase() === target.toLowerCase()
              ) {
                targetPk = obs.accountPk;
                // Back-fill edges for followers observed before we knew the target pk.
                for (const pk of observedPks) linkEdge(pk);
              }
              return;
            }
            // followers-list
            const parsed = this.reader.parseFollowersList(body, this.clock.now());
            for (const obs of parsed.observations) {
              observedPks.add(obs.accountPk);
              this.remember(obs);
              this.store.observe(obs);
              linkEdge(obs.accountPk);
            }
          })
          .catch((e) => {
            logger.warn('foundation.readFollowers: body/parse failed', {
              url: resp.url,
              error: String(e),
            });
          }),
      );
    });

    try {
      await this.adapter.actor.openFollowersDialog(target);

      let stagnantRounds = 0;
      for (let page = 0; page < READ_FOLLOWERS.maxPages; page++) {
        if (!this.requestBudget.canSpend()) {
          logger.warn('foundation.readFollowers: request budget exhausted', { target });
          break;
        }
        const before = observedPks.size;
        this.requestBudget.spend();
        await this.adapter.actor.scrollFollowers();
        await sleep(READ_FOLLOWERS.scrollWaitMs);
        if (observedPks.size === before) {
          stagnantRounds += 1;
          if (stagnantRounds >= READ_FOLLOWERS.stagnantLimit) break;
        } else {
          stagnantRounds = 0;
        }
      }
    } catch (e) {
      logger.error('foundation.readFollowers: failed', { target, error: String(e) });
    } finally {
      // Drain any in-flight body parses so the count and edges are complete.
      await Promise.allSettled(pending);
      unsubscribe();
    }

    logger.info('foundation.readFollowers: done', {
      target,
      observed: observedPks.size,
      edges: edgedPks.size,
    });
    return { target, observed: observedPks.size };
  }

  // -------------------------------------------------------------------------
  // Actions (manual single-shot: ceiling + sentinel + budget only)
  // -------------------------------------------------------------------------

  /**
   * Follow one account. Gated by Sentinel (bail if blocked), the durable hard
   * ceiling, and the request budget. The long inter-action human delay is NOT
   * applied here — that belongs to the Phase-2 churn scheduler; manual single
   * actions only enforce ceiling + sentinel + budget.
   */
  async followOne(username: string): Promise<ActionResult> {
    return this.act(username, 'follow', true);
  }

  /** Unfollow one account — symmetric to {@link followOne}. */
  async unfollowOne(username: string): Promise<ActionResult> {
    return this.act(username, 'unfollow', false);
  }

  private async act(
    username: string,
    action: 'follow' | 'unfollow',
    edgeActive: boolean,
  ): Promise<ActionResult> {
    const sentinel = await this.adapter.sentinel.check();
    if (sentinel !== 'ok') {
      logger.warn('foundation.action: sentinel blocked', { username, action, sentinel });
      return { ok: false, username, reason: `sentinel:${sentinel}` };
    }
    if (this.rateGovernor.atHardCeiling()) {
      logger.warn('foundation.action: daily hard ceiling reached', { username, action });
      return { ok: false, username, reason: 'daily-hard-ceiling' };
    }

    // The Actor navigates to the profile, which fires web_profile_info; capture
    // it so the target pk (for the real-pk edge) and profile stats are recorded.
    const ownPk = await this.ownPk();
    this.requestBudget.spend();
    const capture = this.captureProfiles();

    let result: Result<void> | null = null;
    let thrown: unknown = null;
    try {
      result =
        action === 'follow'
          ? await this.adapter.actor.follow(username)
          : await this.adapter.actor.unfollow(username);
    } catch (e) {
      thrown = e;
    } finally {
      await capture.stop();
    }

    const now = this.clock.now();
    const targetPk = this.pks.lookup(username);
    const ledgerKey = targetPk ?? username;

    if (thrown !== null) {
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      logger.error('foundation.action: actor threw', { username, action, error: reason });
      this.store.recordAction(ledgerKey, action, 'fail', now);
      return { ok: false, username, reason };
    }

    if (result && result.ok) {
      this.store.recordAction(ledgerKey, action, 'ok', now);
      if (ownPk && targetPk) {
        this.store.observeEdge(ownPk, targetPk, 'follows', edgeActive, now);
      } else {
        logger.warn('foundation.action: edge not recorded (unknown pk)', {
          username,
          action,
          hasOwnPk: ownPk !== null,
          hasTargetPk: targetPk !== null,
        });
      }
      logger.info('foundation.action: ok', { username, action, ledgerKey });
      return { ok: true, username };
    }

    const reason = result ? result.reason : 'unknown-actor-result';
    logger.warn('foundation.action: actor reported failure', { username, action, reason });
    this.store.recordAction(ledgerKey, action, 'fail', now);
    return { ok: false, username, reason };
  }

  /**
   * Subscribe to profile-info responses for the duration of one action so the
   * target's pk (and profile stats) land in the store/registry. Returns a
   * `stop()` that drains in-flight parses and unsubscribes.
   */
  private captureProfiles(): { stop: () => Promise<void> } {
    const pending: Promise<void>[] = [];
    const unsubscribe = this.tab.onResponse((resp) => {
      if (this.reader.matchEndpoint(resp.url) !== 'profile-info') return;
      pending.push(
        resp
          .getBody()
          .then((body) => {
            const obs = this.reader.parseProfileInfo(body, this.clock.now());
            if (!obs) return;
            this.remember(obs);
            this.store.observe(obs);
          })
          .catch((e) => {
            logger.warn('foundation.captureProfiles: parse failed', {
              url: resp.url,
              error: String(e),
            });
          }),
      );
    });
    return {
      stop: async (): Promise<void> => {
        await Promise.allSettled(pending);
        unsubscribe();
      },
    };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** A snapshot derived from the store, governors, and tab for the control shell. */
  async status(): Promise<FoundationStatus> {
    const ownPk = await this.ownPk();
    return {
      loggedIn: ownPk !== null,
      currentUrl: this.tab.currentUrl(),
      actionsToday: this.rateGovernor.actionsToday(),
      remainingToday: this.rateGovernor.remainingToday(),
      dailyHardCeiling: RATE_GOVERNOR_DEFAULTS.dailyHardCeiling,
      dailyOperatingRate: RATE_GOVERNOR_DEFAULTS.dailyOperatingRate,
      atHardCeiling: this.rateGovernor.atHardCeiling(),
      requestBudgetRemaining: this.requestBudget.remaining(),
    };
  }

  /** Record an observation's pk/username pairing for later ledger/edge keys. */
  private remember(obs: Observation): void {
    this.pks.remember(obs.fields.username, obs.accountPk);
  }

  /** Close the knowledge store. Call on window teardown. */
  dispose(): void {
    this.store.close();
    logger.info('foundation disposed');
  }
}
