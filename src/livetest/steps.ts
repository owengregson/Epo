/**
 * LiveTestHarness — the engine of the live action smoke-test.
 *
 * It attaches to a live, logged-in `InstagramTab` and drives EVERY real action
 * the app performs — acquire → enrich → score/plan → follow → follow-back check →
 * unfollow → sentinel — against real Instagram, then prints a PASS/FAIL report.
 * It reuses the exact production rim/adapter/store (no reimplementation); this
 * file is only the glue + reporting on top of them.
 *
 * SAFETY (this runs on the user's REAL account — it must never look like a burst):
 *  - Every real Instagram operation is separated by a jittered, jittered delay
 *    (reads/profile-fetches ~4–9s; the follow→unfollow gap ~30–75s).
 *  - Counts are TINY and bounded: acquire scrolls at most a few pages, enrich
 *    touches at most 5 profiles, and there is EXACTLY one follow + one unfollow.
 *    STOPS and reports — it never bypasses the safety net.
 *  - The Sentinel is checked immediately BEFORE the follow and BEFORE the unfollow;
 *    any non-`ok` result ABORTS the sequence right there (no more clicks/navigation).
 *  - No silent `catch {}`: every caught error is logged and surfaces as a FAIL.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, session } from 'electron';
import { resolveOwnUsername as resolveUsernameFromTab } from '@/adapter/identity';
import { asFetchEnvelope, SURFACE } from '@/adapter/ig-surface';
import { InstagramAdapter } from '@/adapter/instagram-adapter';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { IG_PARTITION, type InstagramTab } from '@/adapter/tab';
import { Scanner } from '@/engine/scanner';
import { type ScorerConfig, scoreCandidate } from '@/engine/scorer';
import { SystemClock } from '@/governors/clock';
import { RateGovernor } from '@/governors/rate-governor';
import { AdapterBackedChurnActions } from '@/rim/churn-actions';
import { ACQUISITION_DEFAULTS, AdapterBackedAcquisition } from '@/rim/follower-acquisition';
import { FollowersPageReader } from '@/rim/followers-page-reader';
import { ListPageWalker } from '@/rim/list-page-walker';
import { AdapterBackedProfileEnricher } from '@/rim/profile-enricher';
import type { FollowerAcquisition } from '@/rim/types';
import {
  DEFAULT_SETTINGS,
  toRateGovernorConfig,
  toScannerConfig,
  toScorerConfig,
} from '@/settings/settings';
import { KnowledgeStore } from '@/store/knowledge-store';
import { HARNESS, SCHEDULER } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/** Temp DB file (SEPARATE from epo.db) — deleted + recreated each run. */
const LIVETEST_DB_FILE = 'epo-livetest.db';

/** A fresh uniform draw in [min, max] ms (the shared timing primitive). */
const jittered = (min: number, max: number): number => sample(uniform(min, max));

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function envStr(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export type StepStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface StepResult {
  name: string;
  status: StepStatus;
  detail: string;
}

/** Outcome of one guarded step (SKIP is produced by the runner, not by a step). */
interface StepOutcome {
  status: 'PASS' | 'FAIL';
  detail: string;
}

/** Everything the run prints/returns so the caller can update the banner + verdict. */
export interface LiveTestSummary {
  results: StepResult[];
  verdict: string;
  passes: number;
  fails: number;
  skips: number;
  /** Real follow/unfollow clicks performed (0 in dry-run). */
  actionsPerformed: number;
  dryRun: boolean;
}

/** Env-driven, safe-by-default configuration for one run. */
interface LiveTestConfig {
  target?: string;
  followUser?: string;
  dryRun: boolean;
  opDelayMinMs: number;
  opDelayMaxMs: number;
  enrichPaceMinMs: number;
  enrichPaceMaxMs: number;
  followUnfollowGapMs: number;
  acquireMaxRounds: number;
  enrichCap: number;
}

/** The throwaway dependency graph built once identity resolves. */
interface Graph {
  store: KnowledgeStore;
  reader: Reader;
  sentinel: Sentinel;
  acquisition: FollowerAcquisition;
  enricher: AdapterBackedProfileEnricher;
  churnActions: AdapterBackedChurnActions;
  scanner: Scanner;
  scorerCfg: ScorerConfig;
  /** Constructed for parity with production (hours never gate here); intentionally unused. */
  rate: RateGovernor;
}

export class LiveTestHarness {
  private readonly tab: InstagramTab;
  private readonly cfg: LiveTestConfig;
  private readonly results: StepResult[] = [];

  private store: KnowledgeStore | null = null;

  private aborted = false;
  private abortReason = '';
  private realActions = 0;

  constructor(tab: InstagramTab) {
    this.tab = tab;
    this.cfg = {
      target: envStr('EPO_TEST_TARGET'),
      followUser: envStr('EPO_TEST_FOLLOW'),
      dryRun: process.env.EPO_TEST_DRY === '1',
      opDelayMinMs: envInt('EPO_TEST_OP_DELAY_MIN_MS', HARNESS.OP_DELAY_MIN_MS),
      opDelayMaxMs: envInt('EPO_TEST_OP_DELAY_MAX_MS', HARNESS.OP_DELAY_MAX_MS),
      enrichPaceMinMs: envInt('EPO_TEST_ENRICH_PACE_MIN_MS', HARNESS.ENRICH_PACE_MIN_MS),
      enrichPaceMaxMs: envInt('EPO_TEST_ENRICH_PACE_MAX_MS', HARNESS.ENRICH_PACE_MAX_MS),
      followUnfollowGapMs: envInt('EPO_TEST_FOLLOW_UNFOLLOW_GAP_MS', HARNESS.FOLLOW_UNFOLLOW_GAP_MS),
      acquireMaxRounds: envInt('EPO_TEST_ACQUIRE_ROUNDS', 3),
      enrichCap: envInt('EPO_TEST_ENRICH_CAP', 5),
    };
  }

  // -------------------------------------------------------------------------
  // Public lifecycle
  // -------------------------------------------------------------------------

  /**
   * Run the full sequence. Never throws: each step is wrapped, one failure does
   * not abort the rest, and a detected block aborts the REMAINING clicking steps
   * (SKIP) while still surfacing the sentinel status.
   */
  async run(): Promise<LiveTestSummary> {
    logger.info('livetest: starting', {
      dryRun: this.cfg.dryRun,
      target: this.cfg.target ?? '(own username)',
      followUser: this.cfg.followUser ?? '(unset — steps 5/7 skipped)',
    });
    await this.setStatus('Live action test starting…', 'Resolving identity');

    // --- Step 1: Identity ---------------------------------------------------
    const ownPk = await this.resolveOwnPk();
    const ownUsername = await this.resolveOwnUsername();
    if (ownPk) {
      this.record('1. Identity', 'PASS', `ownPk=${ownPk} ownUsername=${ownUsername ?? '(unresolved)'}`);
    } else {
      this.record('1. Identity', 'FAIL', 'ds_user_id cookie not found — not logged in?');
      this.abort('identity unresolved');
      return this.finish();
    }

    const graph = this.buildGraph(ownPk, ownUsername);
    this.store = graph.store;

    const target = (this.cfg.target ?? ownUsername ?? '').trim();

    // Carried across steps.
    let targetPk: string | null = null;
    let followUserPk: string | null = null;
    let didFollowClick = false;
    let followClickAt = 0;

    // --- Step 2: Acquire ----------------------------------------------------
    await this.setStatus(`Acquiring followers of @${target || '(none)'}…`);
    await this.pacedDelay();
    await this.step('2. Acquire', async () => {
      if (!target) {
        return this.failAbort('no target — set EPO_TEST_TARGET or ensure own username resolves', 'no target');
      }
      const res = await graph.acquisition.acquire(target);
      targetPk = res.targetPk;
      if (res.observed <= 0) {
        // Distinguish an empty/private target from a live block.
        const s = await graph.sentinel.check();
        if (s !== 'ok') return this.failAbort(`sentinel '${s}' during acquire`, `sentinel ${s} during acquire`);
        return { status: 'FAIL', detail: `observed 0 followers for @${target} (sentinel ok — target empty/private/unreachable?)` };
      }
      const samples = this.sampleUsernames(graph.store, targetPk, 2);
      return {
        status: 'PASS',
        detail: `observed=${res.observed} targetPk=${targetPk ?? 'null'} samples=[${samples.join(', ') || 'none'}]`,
      };
    });

    // --- Step 3: Enrich (the critical validation) ---------------------------
    await this.setStatus('Enriching candidate profiles (follower/following counts)…');
    await this.pacedDelay();
    await this.step('3. Enrich', async () => {
      if (!targetPk) return { status: 'FAIL', detail: 'no targetPk from acquire; cannot select candidates' };
      const followerPks = graph.store.followersOf(targetPk);
      const needing: string[] = [];
      for (const pk of followerPks) {
        const acc = graph.store.getAccount(pk);
        if (acc?.username && acc.followers === undefined) needing.push(acc.username);
        if (needing.length >= this.cfg.enrichCap) break;
      }
      if (needing.length === 0) {
        return { status: 'FAIL', detail: 'no acquired usernames lacking counts to enrich' };
      }
      const enriched = await graph.enricher.enrich(needing);
      let withCounts = 0;
      let sample = '';
      for (const pk of followerPks) {
        const acc = graph.store.getAccount(pk);
        if (acc && acc.followers !== undefined && acc.following !== undefined) {
          withCounts += 1;
          if (!sample && acc.username) {
            sample = `@${acc.username} ${acc.followers}/${acc.following} r=${(acc.ratio ?? 0).toFixed(2)}`;
          }
        }
      }
      if (withCounts === 0) {
        const s = await graph.sentinel.check();
        if (s !== 'ok') return this.failAbort(`sentinel '${s}' during enrich`, `sentinel ${s} during enrich`);
        return { status: 'FAIL', detail: `enrich returned ${enriched}; no counts landed in the store` };
      }
      return {
        status: 'PASS',
        detail: `requested=${needing.length} enriched=${enriched} withCounts=${withCounts} e.g. ${sample}`,
      };
    });

    // --- Step 4: Score + plan (pure store reads; no IG traffic) --------------
    await this.setStatus('Scoring + planning candidates…');
    await this.step('4. Score+plan', async () => {
      if (!targetPk) return { status: 'FAIL', detail: 'no targetPk from acquire' };
      const cands = graph.store.candidatePksForTarget(targetPk);
      const plan = graph.scanner.planTarget(targetPk);
      if (plan.queued.length > 0) {
        const top = plan.queued.slice(0, 3).map((pk) => {
          const acc = graph.store.getAccount(pk);
          const s = acc ? scoreCandidate(acc, graph.scorerCfg).score : 0;
          return `{${acc?.username ?? pk}, ${s.toFixed(2)}}`;
        });
        return {
          status: 'PASS',
          detail: `queued=${plan.queued.length}/${plan.considered} eligible=${plan.eligible} top=${top.join(' ')}`,
        };
      }
      if (plan.considered > 0) {
        const reasons = this.tallyReasons(graph.store, cands, graph.scorerCfg);
        return {
          status: 'PASS',
          detail:
            `scoring ran: considered=${plan.considered}, 0 eligible (reasons: ${reasons}). ` +
            `Expected when the ${this.cfg.enrichCap}-profile sample is all ineligible/no-counts.`,
        };
      }
      return { status: 'FAIL', detail: 'no candidate pool (0 considered) — acquire wrote no follower edges' };
    });

    // --- Steps 5–7: follow / follow-back / unfollow (only with a target user) -
    if (!this.cfg.followUser) {
      const note = 'set EPO_TEST_FOLLOW=<username> to test follow/unfollow';
      this.record('5. Follow', 'SKIP', note);
      this.record('6. Follow-back check', 'SKIP', note);
      this.record('7. Unfollow', 'SKIP', note);
    } else {
      const followUser = this.cfg.followUser;

      // --- Step 5: Follow ---------------------------------------------------
      if (this.aborted) {
        this.record('5. Follow', 'SKIP', `aborted: ${this.abortReason}`);
      } else {
        await this.setStatus(`Following @${followUser}…`);
        await this.pacedDelay();
        try {
          {
            const pre = await graph.sentinel.check();
            if (pre !== 'ok') {
              this.record('5. Follow', 'FAIL', `sentinel '${pre}' before follow — aborting (no click)`);
              this.abort(`sentinel ${pre} before follow`);
            } else {
              const outcome = await graph.churnActions.follow(followUser);
              if (outcome.status === 'ok' && outcome.alreadyInState === true) {
                // NOTHING was clicked — the account was ALREADY followed (a
                // real pre-existing relationship). Step 7 must NOT "restore
                // net-zero" by unfollowing a follow that was never ours.
                this.record(
                  '5. Follow',
                  'PASS',
                  `already following @${followUser} (no click) — unfollow step will be skipped`,
                );
              } else if (outcome.status === 'ok') {
                didFollowClick = true;
                followClickAt = Date.now();
                this.realActions += 1;
                this.record('5. Follow', 'PASS', `outcome=ok (real click, post-state verified) @${followUser}`);
              } else if (outcome.status === 'simulated') {
                this.record('5. Follow', 'PASS', `outcome=simulated (dry-run, no click) @${followUser}`);
              } else if (outcome.status === 'blocked') {
                this.record('5. Follow', 'FAIL', 'outcome=blocked (sentinel closed before click)');
                this.abort('follow blocked');
              } else {
                // A click may have landed without confirming — ensure step 7 restores.
                didFollowClick = true;
                followClickAt = Date.now();
                this.record('5. Follow', 'FAIL', `outcome=failed (post-click state unconfirmed) @${followUser}`);
              }
            }
          }
        } catch (e) {
          logger.error('livetest: follow threw', { error: String(e) });
          this.record('5. Follow', 'FAIL', `error: ${String(e)}`);
        }
      }

      // --- Step 6: Follow-back check ---------------------------------------
      if (this.aborted) {
        this.record('6. Follow-back check', 'SKIP', `aborted: ${this.abortReason}`);
      } else {
        await this.setStatus(`Checking follow-back state for @${followUser}…`);
        await this.pacedDelay();
        try {
          followUserPk = await this.resolveUserPk(graph.reader, followUser);
          if (!followUserPk) {
            this.record('6. Follow-back check', 'FAIL', `could not resolve pk for @${followUser} (web_profile_info)`);
          } else {
            await this.pacedDelay();
            const show = await this.fetchFriendshipShow(graph.reader, followUserPk);
            if (!show.parsed) {
              this.record('6. Follow-back check', 'FAIL', `friendships/show did not parse for pk ${followUserPk}`);
            } else {
              this.record('6. Follow-back check', 'PASS', `following=${show.following} followed_by=${show.followedBy}`);
            }
          }
        } catch (e) {
          logger.error('livetest: follow-back check threw', { error: String(e) });
          this.record('6. Follow-back check', 'FAIL', `error: ${String(e)}`);
        }
      }

      // --- Step 7: Unfollow (always attempt when a real click landed) --------
      if (!didFollowClick) {
        this.record(
          '7. Unfollow',
          'SKIP',
          this.cfg.dryRun ? 'dry-run: no real follow to undo' : 'no real follow click occurred',
        );
      } else {
        try {
          // Enforce the follow→unfollow gap (jittered ~0.7–1.6x the base).
          const jitteredGap = jittered(
            this.cfg.followUnfollowGapMs * 0.7,
            this.cfg.followUnfollowGapMs * 1.6,
          );
          const remaining = jitteredGap - (Date.now() - followClickAt);
          if (remaining > 0) {
            await this.setStatus(`Waiting ${Math.round(remaining / 1000)}s before unfollow (gap)…`);
            await sleep(remaining);
          }
          await this.setStatus(`Unfollowing @${followUser} (restore net-zero)…`);
          {
            const pre = await graph.sentinel.check();
            if (pre !== 'ok') {
              this.record(
                '7. Unfollow',
                'FAIL',
                `sentinel '${pre}' before unfollow — NOT clicking during a block; MANUALLY UNFOLLOW @${followUser}`,
              );
              this.abort(`sentinel ${pre} before unfollow`);
            } else {
              const outcome = await graph.churnActions.unfollow(followUser);
              if (outcome.status === 'ok') {
                this.realActions += 1;
                let post = '';
                if (followUserPk) {
                  try {
                    const s = await this.fetchFriendshipShow(graph.reader, followUserPk);
                    post = ` following=${s.following}`;
                  } catch (e) {
                    logger.warn('livetest: post-unfollow friendship-show failed', { error: String(e) });
                  }
                }
                this.record('7. Unfollow', 'PASS', `outcome=ok (restored to Follow)${post}`);
              } else if (outcome.status === 'simulated') {
                this.record('7. Unfollow', 'PASS', 'outcome=simulated (dry-run)');
              } else {
                this.record(
                  '7. Unfollow',
                  'FAIL',
                  `outcome=${outcome.status}; MANUALLY VERIFY @${followUser} is not left followed`,
                );
              }
            }
          }
        } catch (e) {
          logger.error('livetest: unfollow threw', { error: String(e) });
          this.record('7. Unfollow', 'FAIL', `error: ${String(e)}; MANUALLY VERIFY @${followUser} is not left followed`);
        }
      }
    }

    // --- Step 8: Sentinel (read-only; always runs, even after an abort) ------
    await this.setStatus('Final sentinel check…');
    try {
      const status = await graph.sentinel.check();
      this.record('8. Sentinel', status === 'ok' ? 'PASS' : 'FAIL', `status=${status}`);
    } catch (e) {
      logger.error('livetest: sentinel check threw', { error: String(e) });
      this.record('8. Sentinel', 'FAIL', `error: ${String(e)}`);
    }

    return this.finish();
  }

  /** Close the temp store. Idempotent. */
  dispose(): void {
    if (this.store) {
      try {
        this.store.close();
      } catch (e) {
        logger.warn('livetest: store close failed', { error: String(e) });
      }
      this.store = null;
    }
  }

  // -------------------------------------------------------------------------
  // Graph construction (throwaway; temp store, real safety governors)
  // -------------------------------------------------------------------------

  private buildGraph(ownPk: string, ownUsername: string | undefined): Graph {
    const dbPath = path.join(app.getPath('userData'), LIVETEST_DB_FILE);
    // Delete the temp DB (and its WAL sidecars) so every run is clean.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(dbPath + suffix, { force: true });
      } catch (e) {
        logger.warn('livetest: could not remove temp db file', { file: dbPath + suffix, error: String(e) });
      }
    }
    const store = new KnowledgeStore(dbPath);
    const clock = new SystemClock();

    // Active hours 0–24 so wall-clock hours never gate; constructed for parity only.
    const rate = new RateGovernor(store, clock, {
      ...toRateGovernorConfig(DEFAULT_SETTINGS),
      activeHoursStart: 0,
      activeHoursEnd: 24,
    });

    const reader = new Reader();
    const adapter = new InstagramAdapter(this.tab);

    // Reads/scrolls are paced (a single jittered wait, bounded by maxRounds).
    const pageReader = new FollowersPageReader({
      tab: this.tab,
      reader,
      actor: adapter.actor,
      scrollWaitMs: jittered(this.cfg.opDelayMinMs, this.cfg.opDelayMaxMs),
    });

    // Production parity: the direct cursor-resumed walk first, dialog fallback.
    const listWalker = new ListPageWalker({ tab: this.tab, reader });
    const acquisition = new AdapterBackedAcquisition({
      pageReader,
      store,
      sentinel: adapter.sentinel,
      walker: listWalker,
      tab: this.tab,
      reader,
      ownPk,
      cfg: {
        ...ACQUISITION_DEFAULTS,
        maxRounds: this.cfg.acquireMaxRounds,
        noNewStop: 2,
      },
    });

    const enricher = new AdapterBackedProfileEnricher({
      tab: this.tab,
      reader,
      store,
      sentinel: adapter.sentinel,
      batchCap: this.cfg.enrichCap,
      paceMs: this.cfg.enrichPaceMinMs,
      // Jittered inter-fetch pace (~3–5s), overriding the enricher's fixed pace.
      sleep: () => sleep(jittered(this.cfg.enrichPaceMinMs, this.cfg.enrichPaceMaxMs)),
    });

    const churnActions = new AdapterBackedChurnActions({
      adapter,
      store,
      ownPk,
      dryRun: this.cfg.dryRun,
    });

    const scorerCfg = toScorerConfig(DEFAULT_SETTINGS);
    const scanner = new Scanner({ store, scorerCfg, cfg: toScannerConfig(DEFAULT_SETTINGS) });

    logger.info('livetest: graph built', {
      ownPk,
      ownUsername: ownUsername ?? '(unknown)',
      acquireMaxRounds: this.cfg.acquireMaxRounds,
      enrichCap: this.cfg.enrichCap,
      dryRun: this.cfg.dryRun,
    });

    return { store, reader, sentinel: adapter.sentinel, acquisition, enricher, churnActions, scanner, scorerCfg, rate };
  }

  // -------------------------------------------------------------------------
  // Step plumbing
  // -------------------------------------------------------------------------

  /** Run a guarded step; SKIP when already aborted, FAIL (logged) on any throw. */
  private async step(name: string, fn: () => Promise<StepOutcome>): Promise<void> {
    if (this.aborted) {
      this.record(name, 'SKIP', `aborted: ${this.abortReason}`);
      return;
    }
    try {
      const r = await fn();
      this.record(name, r.status, r.detail);
    } catch (e) {
      logger.error('livetest: step threw', { name, error: String(e) });
      this.record(name, 'FAIL', `error: ${String(e)}`);
    }
  }

  /** Record a FAIL and mark the sequence aborted (no more clicks/navigation). */
  private failAbort(detail: string, reason: string): StepOutcome {
    this.abort(reason);
    return { status: 'FAIL', detail };
  }

  private abort(reason: string): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    logger.warn('livetest: ABORTING remaining action steps', { reason });
  }

  private record(name: string, status: StepStatus, detail: string): void {
    this.results.push({ name, status, detail });
    const line = `${name}: ${status} — ${detail}`;
    if (status === 'FAIL') logger.warn(`livetest ${line}`);
    else logger.info(`livetest ${line}`);
  }

  private async pacedDelay(): Promise<void> {
    await sleep(jittered(this.cfg.opDelayMinMs, this.cfg.opDelayMaxMs));
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** The logged-in account pk from the persistent session's `ds_user_id` cookie. */
  private async resolveOwnPk(): Promise<string | null> {
    try {
      const cookies = await session.fromPartition(IG_PARTITION).cookies.get({ name: 'ds_user_id' });
      const cookie = cookies.find((c) => c.value.length > 0);
      return cookie ? cookie.value : null;
    } catch (e) {
      logger.warn('livetest.resolveOwnPk: cookie read failed', { error: String(e) });
      return null;
    }
  }

  /**
   * Own username, resolved robustly: the nav profile-link href / profile
   * navigation (reliable), with `current_user` only as a last resort — see
   * `@/adapter/identity`.
   */
  private async resolveOwnUsername(): Promise<string | undefined> {
    return resolveUsernameFromTab(this.tab, {
      attempts: SCHEDULER.USERNAME_RESOLVE_ATTEMPTS,
      retryMs: SCHEDULER.USERNAME_RESOLVE_RETRY_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Live JSON fetch helpers (same session, x-ig-app-id header)
  // -------------------------------------------------------------------------

  /** Resolve a username → pk via `web_profile_info`, parsed by the real Reader. */
  private async resolveUserPk(reader: Reader, username: string): Promise<string | null> {
    try {
      const raw = await this.tab.evaluate<unknown>(SURFACE.profileInfoScript(username));
      const env = asFetchEnvelope(raw);
      if (env === null || !env.ok) {
        logger.warn('livetest.resolveUserPk: non-ok profile response', {
          username,
          status: env?.status,
          contentType: env?.contentType,
        });
        return null;
      }
      const obs = reader.parseProfileInfo(env.json, Date.now());
      return obs ? obs.accountPk : null;
    } catch (e) {
      logger.error('livetest.resolveUserPk: failed', { username, error: String(e) });
      return null;
    }
  }

  /** Fetch `friendships/show/<pk>` and parse it via the real Reader. */
  private async fetchFriendshipShow(
    reader: Reader,
    pk: string,
  ): Promise<{ parsed: boolean; following: boolean; followedBy: boolean }> {
    const raw = await this.tab.evaluate<unknown>(SURFACE.friendshipShowScript(pk));
    const env = asFetchEnvelope(raw);
    const body = env?.ok ? (env.json as Record<string, unknown> | null) : null;
    const parsed =
      body !== null &&
      typeof body === 'object' &&
      ('following' in body || 'followed_by' in body || body.status === 'ok');
    const res = reader.parseFriendshipShow(body, Date.now(), pk);
    return {
      parsed: parsed && res !== null,
      following: res?.following ?? false,
      followedBy: res?.followedBy ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Reporting helpers
  // -------------------------------------------------------------------------

  /** Up to `n` usernames from a target's observed followers (store-side). */
  private sampleUsernames(store: KnowledgeStore, targetPk: string | null, n: number): string[] {
    if (!targetPk) return [];
    const out: string[] = [];
    for (const pk of store.followersOf(targetPk)) {
      const acc = store.getAccount(pk);
      if (acc?.username) out.push(`@${acc.username}`);
      if (out.length >= n) break;
    }
    return out;
  }

  /** Tally scorer rejection reasons over a candidate pool (for the all-ineligible note). */
  private tallyReasons(store: KnowledgeStore, pks: string[], cfg: ScorerConfig): string {
    const counts = new Map<string, number>();
    for (const pk of pks) {
      const acc = store.getAccount(pk);
      if (!acc) continue;
      const s = scoreCandidate(acc, cfg);
      if (s.eligible) continue;
      const reason = s.reasons[0] ?? 'unknown';
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
    if (counts.size === 0) return 'none';
    return [...counts.entries()].map(([r, c]) => `${r}:${c}`).join(', ');
  }

  /** Compute totals, print the STEP|STATUS|DETAIL table + verdict, return the summary. */
  private finish(): LiveTestSummary {
    const passes = this.results.filter((r) => r.status === 'PASS').length;
    const fails = this.results.filter((r) => r.status === 'FAIL').length;
    const skips = this.results.filter((r) => r.status === 'SKIP').length;
    const verdict =
      fails === 0
        ? `ALL PASS (${passes} passed, ${skips} skipped)`
        : `${fails} FAILED (${passes} passed, ${skips} skipped)`;

    const nameW = Math.max(4, ...this.results.map((r) => r.name.length));
    const statW = 6;
    const bar = `${'-'.repeat(nameW)}-+-${'-'.repeat(statW)}-+-${'-'.repeat(40)}`;

    console.log('\n=== Epo live action test ===');
    console.log(`${'STEP'.padEnd(nameW)} | ${'STATUS'.padEnd(statW)} | DETAIL`);
    console.log(bar);
    for (const r of this.results) {
      console.log(`${r.name.padEnd(nameW)} | ${r.status.padEnd(statW)} | ${r.detail}`);
    }
    console.log(bar);
    console.log(`Instagram actions performed (real follow/unfollow clicks): ${this.realActions}`);
    console.log(`Mode: ${this.cfg.dryRun ? 'DRY-RUN (no real follow/unfollow click)' : 'LIVE'}`);
    if (this.aborted) console.log(`Aborted early: ${this.abortReason}`);
    console.log(`Verdict: ${verdict}`);
    console.log('================================\n');

    logger.info('livetest: complete', {
      verdict,
      actionsPerformed: this.realActions,
      passes,
      fails,
      skips,
    });

    return {
      results: [...this.results],
      verdict,
      passes,
      fails,
      skips,
      actionsPerformed: this.realActions,
      dryRun: this.cfg.dryRun,
    };
  }

  // -------------------------------------------------------------------------
  // On-tab status banner (same technique as the capture harness)
  // -------------------------------------------------------------------------

  /** Log a status line and inject/update an unobtrusive banner at the top of IG. */
  async setStatus(text: string, instruction = ''): Promise<void> {
    logger.info(`livetest.status » ${text}`, instruction ? { instruction } : undefined);
    const title = JSON.stringify(`Epo live test: ${text}`);
    const instr = JSON.stringify(instruction);
    const script = `(() => {
      try {
        var id = '__epo_livetest_banner';
        var el = document.getElementById(id);
        if (!el) {
          el = document.createElement('div');
          el.id = id;
          el.style.cssText = [
            'position:fixed','top:0','left:0','right:0','z-index:2147483647',
            'font:600 12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'background:rgba(14,14,16,0.92)','color:#f5f5f7','padding:6px 12px',
            'border-bottom:1px solid #333','pointer-events:none','letter-spacing:0.2px'
          ].join(';');
          (document.body || document.documentElement).appendChild(el);
        }
        el.innerHTML = '<span>' + ${title} + '</span>' +
          (${instr} ? '<span style="opacity:0.7;font-weight:400;margin-left:10px">' + ${instr} + '</span>' : '');
        return true;
      } catch (e) { return false; }
    })()`;
    try {
      await this.tab.evaluate<boolean>(script);
    } catch (e) {
      logger.warn('livetest.setStatus: banner injection failed', { error: String(e) });
    }
  }
}
