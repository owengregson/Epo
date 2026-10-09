/**
 * The graph session — the lazy build, the identity, and the teardown.
 *
 * The knowledge graph does not exist until the `ds_user_id` cookie resolves.
 * That one fact produced six mutable fields on `Foundation` (`graph`,
 * `buildPromise`, `ownPkCache`, `usernameRetryAt`, `disposing`, `tearingDown`)
 * consulted by ~40 guards across 2,200 lines: a real state machine with no
 * name. `GraphSession` owns those six and publishes a `Session<BuiltGraph>`
 * (`src/kernel/session.ts`), so dependents subscribe to the open/close
 * transitions instead of testing `graph === null`.
 *
 * Every behaviour is a faithful move of the code it replaces: the memoized
 * in-flight build (f6), the degraded-username rebuild backoff (R5), the
 * account-switch teardown, the tour hold, and the ordered bounded drain (f14).
 * `tests/main/*` are the oracle. See ADR 1007.
 */

import { createSession, type MutableSession, type Session } from '@/kernel/session';
import type { BuiltGraph } from '@/main/services/graph-builder';
import type { IgSessionPort } from '@/main/services/ig-session';
import { SCHEDULER, TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import * as logger from '@/utils/logger';

/**
 * Wait out one stopped loop, BOUNDED: quit must never hang behind a wedged loop
 * whose tab await never settles; a rejection on stop is logged, never thrown.
 */
async function awaitLoopExit(what: string, loop: Promise<unknown> | null): Promise<void> {
  if (loop === null) return;
  try {
    const exited = await withTimeout(loop, TAB.TEARDOWN_ENGINE_WAIT_MS);
    if (exited === TIMED_OUT) {
      logger.warn(`foundation.teardownGraph: ${what} did not exit in time, closing anyway`, {
        timeoutMs: TAB.TEARDOWN_ENGINE_WAIT_MS,
      });
    }
  } catch (e) {
    logger.error(`foundation.teardownGraph: ${what} rejected on stop`, { error: String(e) });
  }
}

export interface GraphSessionDeps {
  /** The persistent IG session: the identity cookie. */
  igSession: IgSessionPort;
  /** Assemble the dependency graph for one resolved identity. */
  build(ownPk: string, ownUsername: string | undefined): BuiltGraph;
  /** Best-effort own-username resolution (navigates the tab; retried inside). */
  resolveUsername(): Promise<string | undefined>;
  /** Run the tab-driving tail of the build under the veil's `build` hold. */
  withBuildHold<T>(run: () => Promise<T>): Promise<T>;
  /** True while the intro tour parks every self-starting routine. */
  tourHeld(): boolean;
  /** Await in-flight manual ops (bounded) before the store closes. */
  drainManualOps(): Promise<void>;
}

/** The lazy build, the identity cache and the ordered teardown, behind one object. */
export class GraphSession {
  private readonly deps: GraphSessionDeps;
  private readonly mutable: MutableSession<BuiltGraph> = createSession<BuiltGraph>();

  /**
   * f6 — the in-flight build. Memoized so two concurrent IPC calls landing in
   * {@link ensureBuilt} share ONE build instead of each calling `build()`
   * (which would leak a store, double the metering sub and orphan an engine).
   */
  private buildPromise: Promise<boolean> | null = null;
  private ownPkCache: string | null = null;
  /** Epoch ms of the last failed own-username resolution attempt (backoff). */
  private usernameRetryAt = 0;
  /**
   * True once {@link beginDispose} runs. Read handlers still fire during
   * shutdown, so this makes {@link ensureBuilt} refuse to (re)build.
   */
  private disposingFlag = false;
  /** Temporary twin of `disposing` for a teardown/wipe. Nesting-safe. */
  private tearingDownFlag = false;

  constructor(deps: GraphSessionDeps) {
    this.deps = deps;
  }

  /** The read side: `current()` / `onOpen` / `onClose` for every dependent. */
  get session(): Session<BuiltGraph> {
    return this.mutable;
  }

  /** The live graph, or `null` while the session is closed. */
  current(): BuiltGraph | null {
    return this.mutable.current();
  }

  get disposing(): boolean {
    return this.disposingFlag;
  }

  get tearingDown(): boolean {
    return this.tearingDownFlag;
  }

  /** True once the persistent IG session carries a `ds_user_id` cookie. */
  async isLoggedIn(): Promise<boolean> {
    return (await this.resolveOwnPk()) !== null;
  }

  /**
   * Build the graph exactly once, after login. `false` when not logged in.
   * R5 — a graph built DEGRADED (username unresolved) is not frozen forever: a
   * later call re-attempts resolution and, if it succeeds while the engine is
   * idle, rebuilds so follow-back/own-followers chaining recover.
   */
  async ensureBuilt(): Promise<boolean> {
    // Shutting down / tearing down: never (re)build — let reads resolve to safe
    // empties instead of re-opening the store mid-teardown (the polled reads
    // race the teardown's async drain window).
    if (this.disposingFlag || this.tearingDownFlag) return false;
    // Intro tour on screen: nothing may navigate the tab, so no (re)build and
    // no degraded-username recovery. A built graph keeps serving reads; a
    // missing one waits for the hold to release (see setTourHold).
    if (this.deps.tourHeld()) return this.current() !== null;
    // Fully built (with a real username): nothing more to do.
    const live = this.current();
    if (live !== null && live.ownUsername !== undefined) return true;
    // A DEGRADED graph (username unresolved) is still a built graph. Recovery
    // is retried on a BACKOFF, never on every call: the attempt navigates the
    // tab and fetches `current_user` up to 4 times (~23 s), and 16 routine IPC
    // reads used to re-trigger it each — a loop the rate governor never saw.
    if (live !== null) {
      const sinceLastAttempt = Date.now() - this.usernameRetryAt;
      if (sinceLastAttempt < SCHEDULER.USERNAME_REBUILD_BACKOFF_MS) return true;
      this.usernameRetryAt = Date.now();
    }
    // Coalesce concurrent builds/retries onto a single in-flight promise (f6).
    if (this.buildPromise !== null) return this.buildPromise;
    this.buildPromise = this.buildOrRetry().finally(() => {
      this.buildPromise = null;
    });
    return this.buildPromise;
  }

  /**
   * The not-built guard, centralized: build if needed and hand the graph back,
   * or `null` (each caller returns its own safe empty). Callers hold the
   * RETURNED graph — never re-read `current()` across an await.
   */
  async builtGraph(): Promise<BuiltGraph | null> {
    if (!(await this.ensureBuilt())) return null;
    return this.current();
  }

  /**
   * The memoized body of {@link ensureBuilt}: resolves `ownPk` (required) and
   * `ownUsername` (best-effort, retried — R5).
   */
  private async buildOrRetry(): Promise<boolean> {
    // The pk resolve is passive (a cookie read) — no hold, so pre-login status
    // polls never flash the veil over the login screen. Everything PAST it
    // navigates the tab, so it runs under a `build` hold.
    const ownPk = await this.resolveOwnPk();
    if (ownPk === null) return false;
    return this.deps.withBuildHold(() => this.buildResolved(ownPk));
  }

  /** The tab-driving tail of {@link buildOrRetry} (runs under the `build` hold). */
  private async buildResolved(ownPk: string): Promise<boolean> {
    const ownUsername = await this.deps.resolveUsername();

    const existing = this.current();
    if (existing !== null) {
      // A degraded graph already exists (username was undefined at build time).
      if (ownUsername === undefined) return true; // still no username — keep it.
      const state = existing.engine.status().state;
      if (state === 'running' || state === 'paused') {
        logger.warn('foundation: username recovered but engine active, deferring rebuild', {
          ownUsername,
          state,
        });
        return true;
      }
      logger.info('foundation: own username recovered, rebuilding graph', { ownUsername });
      await this.teardown();
    }

    // A teardown/wipe raced this build past the ensureBuilt gate: abort instead
    // of resurrecting a store over a path that is being torn down or deleted.
    if (this.disposingFlag || this.tearingDownFlag) {
      logger.warn('foundation: build aborted, teardown in progress');
      return false;
    }
    // The open transition IS the wiring: every dependent declared over this
    // session is built here by the kernel's binding rule.
    this.mutable.open(this.deps.build(ownPk, ownUsername));
    logger.info('foundation: dependency graph built', {
      ownPk,
      ownUsername: ownUsername ?? '(unknown)',
    });
    return true;
  }

  /**
   * The logged-in account's pk, from the session's `ds_user_id` cookie (that
   * value IS the account pk). Re-read every call (a cheap partition lookup) so
   * an IN-TAB ACCOUNT SWITCH is caught: a graph anchored to the old pk would
   * write every edge/ledger row against the wrong account. On a switch the
   * stale graph is torn down and the next `ensureBuilt` rebuilds.
   */
  async resolveOwnPk(): Promise<string | null> {
    const value = await this.deps.igSession.readCookie('ds_user_id');
    // A transiently ABSENT or unreadable cookie keeps the cached identity — a
    // navigation blip must not flap a live graph (a real logout parks via the
    // sentinel).
    if (value === null) return this.ownPkCache;
    if (this.ownPkCache !== null && this.ownPkCache !== value) {
      logger.warn('foundation: ds_user_id changed (account switch), tearing down stale graph', {
        from: this.ownPkCache,
        to: value,
      });
      await this.teardown();
    }
    this.ownPkCache = value;
    return value;
  }

  /**
   * Enter the teardown guard, returning the restore. The data wipe wraps its
   * WHOLE body in this, so a read cannot build between the teardown and the `rm`.
   */
  beginTearingDown(): () => void {
    const was = this.tearingDownFlag;
    this.tearingDownFlag = true;
    return () => {
      this.tearingDownFlag = was;
    };
  }

  /** Let a build past the `ensureBuilt` gate settle (it runs on the OLD identity). */
  async settleBuild(): Promise<void> {
    if (this.buildPromise === null) return;
    try {
      await this.buildPromise;
    } catch (e) {
      logger.warn('foundation.clearData: in-flight build rejected during wipe', {
        error: String(e),
      });
    }
  }

  /** Forget the identity + in-flight build; `disposing` stays false so login rebuilds. */
  forgetIdentity(): void {
    this.ownPkCache = null;
    this.buildPromise = null;
  }

  /** Latch shutdown: nothing rebuilds from here on. */
  beginDispose(): void {
    this.disposingFlag = true;
  }

  /**
   * Tear down the current graph (if any): close the session (every dependent
   * disposes — the push machinery first), stop the engine, await its loop,
   * drain manual ops, drop the metering + reconciler subscriptions, close the
   * store — in that order (f14). A store call from a still-running step must
   * never hit a closed DB. A no-op when nothing is built.
   *
   * The whole drain window is guarded: between the close and `store.close()` a
   * polled read's ensureBuilt would otherwise see "not built, not disposing"
   * and open a SECOND store over the same file.
   */
  async teardown(): Promise<void> {
    const graph = this.current();
    if (graph === null) return;
    const restore = this.beginTearingDown();
    try {
      await this.teardownHeld(graph);
    } finally {
      restore();
    }
  }

  /** The body of {@link teardown}, run under the `tearingDown` guard. */
  private async teardownHeld(graph: BuiltGraph): Promise<void> {
    // Closing runs every dependent's disposer synchronously, which is what
    // stops the mutation→push machinery BEFORE anything else: late writes from
    // draining ops must not schedule pushes into a closing store. (It also
    // drops a prune/tour hand-off that has nothing to resume.)
    this.mutable.close();
    graph.engine.stop();
    graph.pruneEngine.stop();
    await awaitLoopExit('engine loop', graph.enginePromise);
    await awaitLoopExit('prune run', graph.prunePromise);
    await this.deps.drainManualOps();
    graph.relationshipReconcilerUnsub();
    graph.profileInfoUnsub();
    graph.delays.dispose();
    graph.store.close();
  }
}
