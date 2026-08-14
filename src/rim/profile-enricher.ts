/**
 * AdapterBackedProfileEnricher — the live `ProfileEnricher` port (R1.1).
 *
 * The system's missing organ: followers-list observations carry no follower/
 * following counts, so `scoreCandidate` returns `no-counts` for every candidate
 * and the pool never shrinks. This class fetches the profile-info endpoint for
 * a batch of candidate usernames and writes the resulting `profiled` counts
 * into the store, so scoring can actually decide.
 *
 * Mechanism (per spec): for each username (up to `batchCap`), if the budget can
 * still spend AND the Sentinel is `ok`, `tab.evaluate` the surface's in-page
 * profile-info fetch script (which resolves to a `FetchEnvelope` — it
 * never rejects on an HTML/error body), parse the JSON via
 * {@link Reader.parseProfileInfo}, and — when non-null — `store.observe` it.
 * The in-page fetch triggers a real IG response that the installed
 * request-metering pipeline counts (R2), so this class only ever *checks* the
 * budget; it never `spend()`s itself.
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
import type { RequestBudget } from '@/governors/request-budget';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock, type Clock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';
import { sleep } from '@/timing/primitives';
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
  budget: RequestBudget;
  sentinel: Sentinel;
  clock?: Clock;
  /** Max usernames enriched per pass (default 25). */
  batchCap?: number;
  /** Pause between fetches, ms (default ~1000). */
  paceMs?: number;
  /** Injected for tests; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Provider of the ACTIVE driver's abort signal — a `stop()` ends the pass
   * between usernames and interrupts the in-flight pacing sleep.
   */
  abortSignal?: () => AbortSignal | undefined;
}

export class AdapterBackedProfileEnricher implements ProfileEnricher {
  private readonly tab: RimTab;
  private readonly reader: Reader;
  private readonly store: KnowledgeStore;
  private readonly budget: RequestBudget;
  private readonly sentinel: Sentinel;
  private readonly clock: Clock;
  private readonly batchCap: number;
  private readonly paceMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly abortSignal?: () => AbortSignal | undefined;

  constructor(deps: ProfileEnricherDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.store = deps.store;
    this.budget = deps.budget;
    this.sentinel = deps.sentinel;
    this.clock = deps.clock ?? new SystemClock();
    this.batchCap = deps.batchCap ?? DEFAULT_BATCH_CAP;
    this.paceMs = deps.paceMs ?? RIM.ENRICH_PACE_MS;
    this.sleep = deps.sleep ?? sleep;
    this.abortSignal = deps.abortSignal;
  }

  async enrich(usernames: string[]): Promise<number> {
    const batch = usernames.slice(0, this.batchCap);
    let enriched = 0;

    for (let i = 0; i < batch.length; i++) {
      const username = batch[i];

      // A stopped driver ends the pass between usernames (a future pass retries).
      if (this.abortSignal?.()?.aborted) {
        logger.info('rim.profile-enricher: driver stopped, ending pass', { username });
        break;
      }

      // Budget/sentinel are gated like any IG work — but blocking here just skips
      // this username (a future pass retries it); it is not a failure.
      if (!this.budget.canSpend()) {
        logger.warn('rim.profile-enricher: request budget exhausted, skipping', { username });
        continue;
      }
      const status = await this.sentinel.check();
      if (status !== 'ok') {
        logger.warn('rim.profile-enricher: sentinel non-ok, skipping', { username, status });
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
        logger.warn('rim.profile-enricher: non-ok response, skipping', {
          username,
          status: env.status,
          contentType: env.contentType,
        });
        await this.pace(i, batch.length);
        continue;
      }

      const obs = this.reader.parseProfileInfo(env.json, this.clock.now());
      if (obs === null) {
        logger.warn('rim.profile-enricher: unparseable profile body, skipping', { username });
        await this.pace(i, batch.length);
        continue;
      }

      this.store.observe(obs);
      enriched += 1;
      logger.debug('rim.profile-enricher: enriched', { username, pk: obs.accountPk });

      await this.pace(i, batch.length);
    }

    logger.info('rim.profile-enricher: pass complete', {
      requested: usernames.length,
      attempted: batch.length,
      enriched,
    });
    return enriched;
  }

  /** Light pacing between fetches; no wait after the final username. */
  private async pace(index: number, length: number): Promise<void> {
    if (index < length - 1) await this.sleep(this.paceMs, this.abortSignal?.());
  }
}
