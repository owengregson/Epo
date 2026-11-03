/**
 * AdapterBackedProfileEnricher — the live `ProfileEnricher` port (R1.1).
 *
 * The system's missing organ: followers-list observations carry no follower/
 * following counts, so `scoreCandidate` returns `no-counts` for every candidate
 * and the pool never shrinks. This class reads the profile of each candidate in
 * a batch so scoring can actually decide.
 *
 * Mechanism (since 2026-10-08): for each username (up to `batchCap`), if the
 * Sentinel is `ok`, VISIT the profile (`ProfileVisitor`) — the page's own
 * client fetches the profile, and the ProfileObserver writes the counts to the
 * store as the body parses. Every REST profile read Epo used to compose is
 * walled (`/users/<pk>/info/` answers 429), and a visit composes no request.
 *
 * This class owns the PASS: sentinel gating, pacing, the wall streak, the
 * permanent `gone` marker and the veil's progress. No silent catch: every
 * non-ok visit is a typed outcome, WARN-logged and skipped. Returns the number
 * of usernames whose profile was actually read.
 */

import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import type { Sentinel } from '@/adapter/sentinel';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import type { ProfileVisitor } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RECOVERY, RIM } from '@/timing/config';
import { sample, sleep, uniform } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/** Default number of usernames enriched per pass. */
const DEFAULT_BATCH_CAP = 25;

/**
 * The enrichment port the Engine calls before planning a target (structurally
 * matches the Engine's `EngineEnricher`). Returns how many were enriched.
 */
export interface ProfileEnricher {
  enrich(usernames: string[]): Promise<number>;
  budgetResumeAt?(): number | null;
}

export interface ProfileEnricherDeps {
  onProgress?: (phase: string) => void;
  readBudget?: ReadBudget;
  /** Reads a profile by opening it; the observer behind it writes the store. */
  visitor: ProfileVisitor;
  /** For the permanent `gone` marker only — the counts are the observer's write. */
  store: Pick<KnowledgeStore, 'markEnrichmentFailed'>;
  sentinel: Sentinel;
  clock?: Clock;
  /** Max usernames enriched per pass (default 25). */
  batchCap?: number;
  /** Fixed pause between visits, ms; default is a fresh jittered draw per visit. */
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
  private readonly onProgress?: (phase: string) => void;
  private readonly readBudget?: ReadBudget;
  private readResumeAt: number | null = null;
  private readonly visitor: ProfileVisitor;
  private readonly store: Pick<KnowledgeStore, 'markEnrichmentFailed'>;
  private readonly sentinel: Sentinel;
  private readonly clock: Clock;
  private readonly batchCap: number;
  private readonly paceMs?: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: ProfileEnricherDeps) {
    this.onProgress = deps.onProgress;
    this.readBudget = deps.readBudget;
    this.visitor = deps.visitor;
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
    this.readResumeAt = null;
    const batch = usernames.slice(0, this.batchCap);
    let enriched = 0;
    // Enrichment visits profile pages — a 'page' phase. The batch size is an
    // exact denominator, so the overlay draws a true bar.
    const reportActivity = (count: number): void =>
      this.reporter.report({
        kind: 'page',
        op: { op: 'visit-profiles', done: count, total: batch.length },
      });

    // Consecutive visits a WALL answered — or that never answered at all. A
    // streak is a wall, not luck: the rest of the batch would only deepen it.
    let walledInARow = 0;
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

      const permit = this.readBudget?.consume('profile');
      if (permit !== undefined && !permit.allowed) {
        this.readResumeAt = permit.resumeAt;
        break;
      }
      const visit = await this.visitor.visit(username);
      if (!visit.ok) {
        // `gone` is the page itself saying the profile is not available
        // (deleted / renamed / hidden from us) with no profile fetched: mark it
        // so batch selection stops resending it. Everything else is transient.
        if (visit.kind === 'gone') {
          this.store.markEnrichmentFailed(username, this.clock.now());
          logger.warn('rim.profile-enricher: profile gone, marking enrich-failed', { username });
        } else {
          logger.warn('rim.profile-enricher: visit failed, skipping', { kind: visit.kind, ...visit.detail });
        }
        // A tab that cannot navigate will not recover mid-pass.
        if (visit.kind === 'tab') break;
        walledInARow = visit.kind === 'walled' || visit.kind === 'unanswered' ? walledInARow + 1 : 0;
        if (walledInARow >= RECOVERY.BLOCKED_STREAK_ENTRY) {
          logger.warn('rim.profile-enricher: read wall, ending the pass early', {
            walledInARow,
            unread: batch.length - i - 1,
          });
          break;
        }
        // Pace even on failure so a run of failures cannot hammer the site.
        await this.pace(i, batch.length);
        continue;
      }
      walledInARow = 0;
      enriched += 1;
      this.onProgress?.('profile-enriched');
      logger.debug('rim.profile-enricher: enriched', { username, pk: visit.obs.accountPk });

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

  budgetResumeAt(): number | null { return this.readResumeAt; }

  /**
   * Pacing between visits; no wait after the final username. Each wait is a
   * fresh jittered draw (an enrichment pass is the app's largest read burst —
   * a fixed 1 s cadence used to fire 20 profile reads in ~20 s).
   */
  private async pace(index: number, length: number): Promise<void> {
    if (index >= length - 1) return;
    const ms =
      this.paceMs ?? sample(uniform(RIM.ENRICH_PACE_MIN_MS, RIM.ENRICH_PACE_MAX_MS));
    await this.sleep(ms, this.abortSignal?.());
  }
}
