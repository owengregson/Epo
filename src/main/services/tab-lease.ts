/**
 * Who owns the one shared Instagram tab.
 *
 * There is exactly one page, and two long-running routines want it: the growth
 * loop and the prune scan/run. The intro tour wants nobody on it at all. This
 * object holds that whole state machine — the driver token, the two "WE paused
 * growth, so WE resume it" hand-offs, the tour hold, and the two small latches
 * that ride with them — so the rules live in one testable place instead of six
 * booleans on the composition root.
 *
 * Two invariants the callers depend on:
 *
 *  - A borrower resumes growth ONLY if it was the one that paused it. A pause
 *    the USER performed is never silently undone.
 *  - `pause()` returns while the in-flight growth step (a follow click, an
 *    acquisition scroll) is still running, so a borrower ALWAYS waits for the
 *    pause gate before it touches the tab — including when the user paused.
 */

import * as logger from '@/utils/logger';

/** The two routines that can drive the tab. */
export type TabOwner = 'growth' | 'prune';

/** Who took the tab away from a running growth loop, and therefore owes it back. */
export type GrowthBorrower = 'prune' | 'tour';

/** The slice of the growth Engine the hand-off drives. */
export interface LeaseGrowthEngine {
  status(): { state: 'idle' | 'running' | 'paused' | 'halted' };
  pause(): void;
  resume(): void;
  /** Resolves true once the loop sits at the pause gate (no step mid-flight). */
  awaitParked(timeoutMs: number): Promise<boolean>;
}

export class TabLease {
  /**
   * The tab driver token. Growth start is refused while `'prune'` holds it; a
   * prune scan/run is refused while another prune holds it. Set around each
   * run, cleared when the run's promise settles.
   */
  private driver: TabOwner | null = null;
  private generation = 0;
  private readonly borrowedGrowth = new Set<GrowthBorrower>();

  /** Borrowers that paused a RUNNING growth loop and therefore owe a resume. */
  private readonly owedResume = new Set<GrowthBorrower>();

  /** True while the renderer's intro tour is on screen (`tour:hold` IPC). */
  private tourHold = false;

  /** A profile landing was requested while the tour hold was up. */
  private profileLandDeferred = false;

  /** True between a growth start and the engine's first status emit. */
  private growthStarting = false;

  // --- Driver token ----------------------------------------------------------

  /** Who currently drives the tab, or null when it is free. */
  owner(): TabOwner | null {
    return this.driver;
  }

  owns(owner: TabOwner, generation: number): boolean {
    return this.driver === owner && this.generation === generation;
  }

  /** Take the token. The caller has already checked that the tab is free. */
  claim(owner: TabOwner): number {
    this.driver = owner;
    return ++this.generation;
  }

  /** Drop the token IFF `owner` still holds it (a stale run may not steal it). */
  release(owner: TabOwner, generation?: number): void {
    if (this.driver === owner && (generation === undefined || generation === this.generation)) this.driver = null;
  }

  // --- Growth hand-off -------------------------------------------------------

  /**
   * Take the tab away from the growth loop for `borrower`. A growth engine that
   * is idle or halted leaves the tab free already; a RUNNING one is paused and
   * recorded as owed. Either way the caller waits for quiescence — `pause()`
   * returns before the in-flight step ends, and handing the tab over at that
   * moment puts two drivers on one WebContents.
   *
   * Returns false (having undone our own pause) when a live loop will not park
   * inside `parkTimeoutMs`: a borrower must never share the tab with a live
   * growth step.
   */
  async borrowFromGrowth(
    borrower: GrowthBorrower,
    engine: LeaseGrowthEngine | null,
    parkTimeoutMs: number,
  ): Promise<boolean> {
    if (engine === null) return false;
    const state = engine.status().state;
    if (state === 'idle' || state === 'halted') return true; // tab already free
    this.borrowedGrowth.add(borrower);
    this.pauseGrowthFor(borrower, engine);
    const parked = await engine.awaitParked(parkTimeoutMs);
    if (!parked) {
      logger.warn('tab-lease: growth did not park in time, aborting hand-off', { borrower });
      this.returnToGrowth(borrower, engine);
      return false;
    }
    return true;
  }

  /**
   * Pause a RUNNING growth loop for `borrower` and record the owed resume.
   * Does NOT wait for the pause gate — that is only needed by a borrower that
   * will DRIVE the page (see {@link borrowFromGrowth}); the tour hold merely
   * needs the loop to stop scheduling work.
   */
  pauseGrowthFor(borrower: GrowthBorrower, engine: LeaseGrowthEngine | null): void {
    if (engine === null || engine.status().state !== 'running') return;
    logger.info('tab-lease: pausing growth engine for hand-off', { borrower });
    engine.pause();
    this.owedResume.add(borrower);
  }

  /**
   * Give the tab back: resume the growth engine IFF `borrower` paused it (never
   * undo a user's own pause, and never resume a torn-down graph). Idempotent.
   */
  returnToGrowth(borrower: GrowthBorrower, engine: LeaseGrowthEngine | null): void {
    const owed = this.owedResume.delete(borrower);
    const borrowed = this.borrowedGrowth.delete(borrower);
    if (!owed && !borrowed) return;
    if (engine === null) return;
    if (engine.status().state !== 'paused') return;
    this.claim('growth');
    if (!owed) return;
    logger.info('tab-lease: resuming growth engine after hand-off', { borrower });
    engine.resume();
  }

  /** Forget every owed resume — the graph they referred to is gone. */
  forgetHandoffs(): void {
    this.owedResume.clear();
    this.borrowedGrowth.clear();
  }

  // --- Tour hold -------------------------------------------------------------

  /** True while nothing may self-start (lazy build, profile landing, schedules). */
  tourHeld(): boolean {
    return this.tourHold;
  }

  /** Set the tour hold; returns false when the value was already that (a no-op). */
  setTourHeld(held: boolean): boolean {
    if (this.tourHold === held) return false;
    this.tourHold = held;
    return true;
  }

  /** Remember that a profile landing was requested while the hold was up. */
  deferProfileLanding(): void {
    this.profileLandDeferred = true;
  }

  /** Consume the deferred landing: true exactly once per {@link deferProfileLanding}. */
  takeDeferredProfileLanding(): boolean {
    if (!this.profileLandDeferred) return false;
    this.profileLandDeferred = false;
    return true;
  }

  // --- Growth spin-up bridge -------------------------------------------------

  /**
   * Arm the veil's spin-up bridge: the gap between a growth start and the
   * engine's first status emit, over which the activity signal would otherwise
   * dip. Returns false when it is already armed.
   */
  beginGrowthStart(): boolean {
    if (this.growthStarting) return false;
    this.growthStarting = true;
    return true;
  }

  /** Retire the bridge; true exactly once per armed {@link beginGrowthStart}. */
  endGrowthStart(): boolean {
    if (!this.growthStarting) return false;
    this.growthStarting = false;
    return true;
  }
}
