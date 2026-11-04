/**
 * AdapterBackedProfileEnricher — the live `ProfileEnricher` port (R1.1).
 *
 * The system's missing organ: followers-list observations carry no follower/
 * following counts, so `scoreCandidate` returns `no-counts` for every candidate
 * and the pool never shrinks. This class reads the profile of each candidate in
 * a batch so scoring can actually decide.
 *
 * Mechanism (since 2026-10-08): for each username the caller hands it, if the
 * Sentinel is `ok`, VISIT the profile (`ProfileVisitor`) — the page's own
 * client fetches the profile, and the ProfileObserver writes the counts to the
 * store as the body parses. Every REST profile read Epo used to compose is
 * walled (`/users/<pk>/info/` answers 429), and a visit composes no request.
 *
 * This class owns the PASS: sentinel gating, the wall streak, the permanent `gone` marker and the
 * veil's progress; it waits nothing of its own (the visitor enters each visit on the activity
 * clock, spec §5.16). No silent catch: every non-ok visit is a typed outcome, WARN-logged and
 * skipped. Returns the number of usernames whose profile was actually read.
 */

import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import type { Sentinel } from '@/adapter/sentinel';
import { type Clock, SystemClock } from '@/governors/clock';
import type { ReadBudget } from '@/governors/read-budget';
import { countsUnread, type ProfileVisitor } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RECOVERY } from '@/timing/config';
import * as logger from '@/utils/logger';

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
  store: Pick<KnowledgeStore, 'markEnrichmentFailed'> & Partial<Pick<KnowledgeStore, 'pkByUsername'>>;
  sentinel: Sentinel;
  clock?: Clock;
  /** Max usernames enriched per pass; absent, the caller's slice is the bound (`min(profilesPerSlice, explore left)`). */
  batchCap?: number;
  /** Provider of the ACTIVE driver's abort signal — a `stop()` ends the pass between usernames. */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
}

export class AdapterBackedProfileEnricher implements ProfileEnricher {
  private readonly onProgress?: (phase: string) => void;
  private readonly readBudget?: ReadBudget;
  private readResumeAt: number | null = null;
  private readonly visitor: ProfileVisitor;
  private readonly store: Pick<KnowledgeStore, 'markEnrichmentFailed'> & Partial<Pick<KnowledgeStore, 'pkByUsername'>>;
  private readonly sentinel: Sentinel;
  private readonly clock: Clock;
  private readonly batchCap: number | undefined;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(deps: ProfileEnricherDeps) {
    this.onProgress = deps.onProgress;
    this.readBudget = deps.readBudget;
    this.visitor = deps.visitor;
    this.store = deps.store;
    this.sentinel = deps.sentinel;
    this.clock = deps.clock ?? new SystemClock();
    this.batchCap = deps.batchCap;
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

      // The sentinel gates like any IG work: a non-ok page ends the pass (a future pass retries
      // the rest), so a persistent block can never spin the pass through the batch.
      const status = await this.sentinel.check();
      if (status !== 'ok') {
        logger.warn('rim.profile-enricher: sentinel non-ok, ending pass', { username, status });
        break;
      }

      const permit = this.readBudget?.consume('profile');
      if (permit !== undefined && !permit.allowed) {
        this.readResumeAt = permit.resumeAt;
        break;
      }
      const pk = this.store.pkByUsername?.(username) ?? undefined;
      const visit = await this.visitor.visit(username, pk === undefined ? undefined : { pk });
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
        continue;
      }
      if (countsUnread(visit)) {
        // A body without a valid count pair is a failed read (spec §10.4): it counts in the
        // streak, so a drifted count ends the pass instead of re-visiting every pass.
        logger.warn('rim.profile-enricher: profile read without its counts, skipping', { username });
        walledInARow += 1;
        if (walledInARow >= RECOVERY.BLOCKED_STREAK_ENTRY) break;
        continue;
      }
      walledInARow = 0;
      enriched += 1;
      this.onProgress?.('profile-enriched');
      logger.debug('rim.profile-enricher: enriched', { username, pk: visit.obs.accountPk });
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
}
