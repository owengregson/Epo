/**
 * AdapterBackedProfileEnricher — the live `ProfileEnricher` port (R1.1).
 *
 * The system's missing organ: followers-list observations carry no follower/
 * following counts, so `scoreCandidate` returns `no-counts` for every candidate
 * and the pool never shrinks. This class fetches the profile-info endpoint for
 * a batch of candidate usernames and writes the resulting `profiled` counts
 * into the store, so scoring can actually decide.
 *
 * Mechanism (per spec): for each username (up to `batchCap`), if the Sentinel
 * is `ok`, `tab.evaluate` the surface's in-page profile-info fetch script
 * (which resolves to a `FetchEnvelope` — it never rejects on an HTML/error
 * body), parse the JSON via {@link Reader.parseProfileInfo}, and — when
 * non-null — `store.observe` it.
 *
 * Robustness: no silent catch. A per-username `tab.evaluate` rejection is
 * logged and skipped; a non-ok envelope (rate-limit wall, HTML interstitial,
 * network error) or a malformed/`null` body is WARN-logged and skipped; the
 * pass continues with the next username. Returns the number of usernames
 * actually enriched (observed).
 */

import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { SURFACE, asFetchEnvelope } from '@/adapter/ig-surface';
import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock, type Clock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';
import { sample, sleep, uniform } from '@/timing/primitives';
import { RIM } from '@/timing/config';

/** Default number of usernames enriched per pass. */
const DEFAULT_BATCH_CAP = 25;

/**
 * The enrichment port the Engine calls before planning a target (structurally
 * matches the Engine's `EngineEnricher`). Returns how many were enriched.
 */
export interface ProfileEnricher {
  enrich(usernames: string[]): Promise<number>;
}

export interface ProfileEnricherDeps {
  tab: RimTab;
  reader: Reader;
  store: KnowledgeStore;
  sentinel: Sentinel;
  clock?: Clock;
  /** Max usernames enriched per pass (default 25). */
  batchCap?: number;
  /** Fixed pause between fetches, ms; default is a fresh jittered draw per fetch. */
  paceMs?: number;
  /** Injected for tests; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Provider of the ACTIVE driver's abort signal — a `stop()` ends the pass
   * between usernames and interrupts the in-flight pacing sleep.
   */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
}

export class AdapterBackedProfileEnricher implements ProfileEnricher {
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly store: KnowledgeStore;
  private readonly sentinel: Sentinel;
  private readonly clock: Clock;
  private readonly batchCap: number;
  private readonly paceMs?: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: ProfileEnricherDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.store = deps.store;
    this.sentinel = deps.sentinel;
    this.clock = deps.clock ?? new SystemClock();
    this.batchCap = deps.batchCap ?? DEFAULT_BATCH_CAP;
    this.paceMs = deps.paceMs;
    this.sleep = deps.sleep ?? sleep;
    this.abortSignal = deps.abortSignal;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
  }

  async enrich(usernames: string[]): Promise<number> {
    const batch = usernames.slice(0, this.batchCap);
    let enriched = 0;
    // Profile enrichment fetches web_profile_info directly — an 'api' phase.
    // The batch size is an exact denominator, so the overlay draws a true bar.
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'api',
        label: 'Reading profiles',
        count,
        total: batch.length,
      });

    for (let i = 0; i < batch.length; i++) {
      const username = batch[i];
      // Progress = usernames COMPLETED so far, counted at the top of each
      // iteration so it advances on every exit path (enriched, skipped by the
      // sentinel, rate-walled) rather than stalling whenever one is skipped.
      reportActivity(i);

      // A stopped driver ends the pass between usernames (a future pass retries).
      if (this.abortSignal?.()?.aborted) {
        logger.info('rim.profile-enricher: driver stopped, ending pass', { username });
        break;
      }

      // The sentinel gates like any IG work — but blocking here just skips
      // this username (a future pass retries it); it is not a failure.
      const status = await this.sentinel.check();
      if (status !== 'ok') {
        logger.warn('rim.profile-enricher: sentinel non-ok, skipping', { username, status });
        // Pace even on a block: without this, a PERSISTENT sentinel wall turns the
        // pass into a tight zero-delay `sentinel.check()` spin loop (parity with
        // every other exit path below, which all pace before continuing).
        await this.pace(i, batch.length);
        continue;
      }

      let raw: unknown;
      try {
        raw = await this.tab.evaluate<unknown>(SURFACE.profileInfoScript(username));
      } catch (e) {
        logger.error('rim.profile-enricher: fetch/evaluate failed', {
          username,
          error: String(e),
        });
        // Pace even on failure so a run of errors cannot hammer the endpoint.
        await this.pace(i, batch.length);
        continue;
      }

      // The script resolves to a FetchEnvelope — an HTML wall, rate-limit or
      // network error is a typed non-ok envelope, NOT a raw error. Skip and
      // continue (a future pass retries) with a warn, never an error log.
      const env = asFetchEnvelope(raw);
      if (env === null) {
        logger.warn('rim.profile-enricher: unexpected evaluate result (no envelope), skipping', {
          username,
        });
        await this.pace(i, batch.length);
        continue;
      }
      if (!env.ok) {
        // A 404 is Instagram's definitive "no such profile" (deleted/
        // suspended/renamed): mark it so the engine's batch selection stops
        // resending it every pass of every cycle. Any OTHER non-ok status
        // (rate wall, HTML interstitial, 5xx) is transient — never marked.
        if (env.status === 404) {
          this.store.markEnrichmentFailed(username, this.clock.now());
          logger.warn('rim.profile-enricher: profile 404, marking enrich-failed', { username });
        } else {
          logger.warn('rim.profile-enricher: non-ok response, skipping', {
            username,
            status: env.status,
            contentType: env.contentType,
          });
        }
        await this.pace(i, batch.length);
        continue;
      }

      const obs = this.reader.parseProfileInfo(env.json, this.clock.now());
      if (obs === null) {
        // A 2xx body that yields no observation is AMBIGUOUS: it can be a
        // genuinely-gone profile (`data.user` empty) but also a soft-block
        // body a wall returns with status 200 — so it is skipped, never
        // permanently marked. Definitive deletion is the 404 branch above.
        logger.warn('rim.profile-enricher: profile body yielded no observation, skipping', {
          username,
        });
        await this.pace(i, batch.length);
        continue;
      }

      this.store.observe(obs);
      enriched += 1;
      logger.debug('rim.profile-enricher: enriched', { username, pk: obs.accountPk });

      await this.pace(i, batch.length);
    }

    this.reporter.clear();
    logger.info('rim.profile-enricher: pass complete', {
      requested: usernames.length,
      attempted: batch.length,
      enriched,
    });
    return enriched;
  }

  /**
   * Pacing between fetches; no wait after the final username. Each wait is a
   * fresh jittered draw (an enrichment pass is the app's largest read burst —
   * a fixed 1 s cadence used to fire 20 profile fetches in ~20 s).
   */
  private async pace(index: number, length: number): Promise<void> {
    if (index >= length - 1) return;
    const ms =
      this.paceMs ?? sample(uniform(RIM.ENRICH_PACE_MIN_MS, RIM.ENRICH_PACE_MAX_MS));
    await this.sleep(ms, this.abortSignal?.());
  }
}
