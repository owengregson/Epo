/**
 * AdapterBackedProfileEnricher — the live `ProfileEnricher` port (R1.1).
 *
 * The system's missing organ: followers-list observations carry no follower/
 * following counts, so `scoreCandidate` returns `no-counts` for every candidate
 * and the pool never shrinks. This class fetches `web_profile_info` for a batch
 * of candidate usernames and writes the resulting `profiled` counts into the
 * store, so scoring can actually decide.
 *
 * Mechanism (per spec): for each username (up to `batchCap`), if the budget can
 * still spend AND the Sentinel is `ok`, `tab.evaluate` an in-page `fetch` of the
 * private `web_profile_info` endpoint (with the `x-ig-app-id` header + session
 * credentials), parse the body via {@link Reader.parseProfileInfo}, and — when
 * non-null — `store.observe` it. The in-page fetch triggers a real IG response
 * that the installed request-metering pipeline counts (R2), so this class only
 * ever *checks* the budget; it never `spend()`s itself.
 *
 * Robustness: no silent catch. A per-username `tab.evaluate` rejection or a
 * malformed/`null` body is logged and skipped; the pass continues with the next
 * username. Returns the number of usernames actually enriched (observed).
 */

import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { RequestBudget } from '@/governors/request-budget';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { SystemClock, type Clock } from '@/governors/clock';
import type { RimTab } from '@/rim/types';
import * as logger from '@/utils/logger';

const IG_APP_ID = '936619743392459';

/** Default number of usernames enriched per pass. */
const DEFAULT_BATCH_CAP = 25;

/** Default pause between fetches so a pass does not hammer Instagram (~1s). */
const DEFAULT_PACE_MS = 1000;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  sleep?: (ms: number) => Promise<void>;
}

/** Build the in-page fetch script for one username. */
function profileInfoScript(username: string): string {
  const u = JSON.stringify(username);
  return (
    `fetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(${u}), ` +
    `{ headers: { 'x-ig-app-id': '${IG_APP_ID}' }, credentials: 'include' })` +
    `.then(function (r) { return r.json(); })`
  );
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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ProfileEnricherDeps) {
    this.tab = deps.tab;
    this.reader = deps.reader;
    this.store = deps.store;
    this.budget = deps.budget;
    this.sentinel = deps.sentinel;
    this.clock = deps.clock ?? new SystemClock();
    this.batchCap = deps.batchCap ?? DEFAULT_BATCH_CAP;
    this.paceMs = deps.paceMs ?? DEFAULT_PACE_MS;
    this.sleep = deps.sleep ?? realSleep;
  }

  async enrich(usernames: string[]): Promise<number> {
    const batch = usernames.slice(0, this.batchCap);
    let enriched = 0;

    for (let i = 0; i < batch.length; i++) {
      const username = batch[i];

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

      let body: unknown;
      try {
        body = await this.tab.evaluate<unknown>(profileInfoScript(username));
      } catch (e) {
        logger.error('rim.profile-enricher: fetch/evaluate failed', {
          username,
          error: String(e),
        });
        // Pace even on failure so a run of errors cannot hammer the endpoint.
        await this.pace(i, batch.length);
        continue;
      }

      const obs = this.reader.parseProfileInfo(body, this.clock.now());
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
    if (index < length - 1) await this.sleep(this.paceMs);
  }
}
