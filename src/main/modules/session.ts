/**
 * The graph session — the store-first open, the identity, and the teardown.
 *
 * The knowledge graph does not exist until the `ds_user_id` cookie resolves.
 * `GraphSession` owns that state machine (the in-flight open, the cached pk,
 * `disposing`, `tearingDown`) and publishes a `Session<BuiltGraph>`
 * (`src/kernel/session.ts`), so dependents subscribe to the open/close
 * transitions instead of testing `graph === null`.
 *
 * Identity is store-first (spec §12.8, ADR 1010): the graph opens from the
 * store alone, with the own username from the store's own account row, so no
 * read path ever navigates the tab. Only confirm-account rebuilds, through
 * {@link GraphSession.rebuildWith}. Kept from before: the memoized open (f6),
 * the account-switch teardown and the ordered bounded drain (f14).
 */

import { createSession, type MutableSession, type Session } from '@/kernel/session';
import type { BuiltGraph } from '@/main/services/graph-builder';
import type { IgSessionPort } from '@/main/services/ig-session';
import { TAB } from '@/timing/config';
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
  /** Assemble the graph for one identity; an undefined username is read from the store's own account row. */
  build(ownPk: string, ownUsername: string | undefined): BuiltGraph;
  /** Await in-flight manual ops (bounded) before the store closes. */
  drainManualOps(): Promise<void>;
  /** Identity changes revoke the old run before any new graph can be admitted. */
  onIdentityChanged?(): void;
}

/** The lazy build, the identity cache and the ordered teardown, behind one object. */
export class GraphSession {
  private readonly deps: GraphSessionDeps;
  private readonly mutable: MutableSession<BuiltGraph> = createSession<BuiltGraph>();

  /**
   * f6 — the in-flight open or rebuild. Memoized so concurrent IPC calls share
   * ONE build instead of each calling `build()` (which would leak a store,
   * double the metering sub and orphan an engine).
   */
  private buildPromise: Promise<boolean> | null = null;
  private ownPkCache: string | null = null;
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
   * Open the graph from the store alone, once, after login: no tab work, and
   * `false` when not logged in. Shutting down or tearing down never (re)builds,
   * so polled reads resolve to safe empties instead of re-opening the store
   * mid-teardown. The passive identity is revalidated on every call.
   */
  openFromStore(): Promise<boolean> {
    if (this.disposingFlag || this.tearingDownFlag) return Promise.resolve(false);
    if (this.buildPromise !== null) return this.buildPromise;
    return this.memoize(this.openIdentity());
  }

  /** Every read path opens store-first (see {@link openFromStore}). */
  ensureBuilt(): Promise<boolean> {
    return this.openFromStore();
  }

  /** Hold `build` as the one in-flight build until it settles. */
  private memoize(build: Promise<boolean>): Promise<boolean> {
    const held: Promise<boolean> = build.finally(() => {
      if (this.buildPromise === held) this.buildPromise = null;
    });
    this.buildPromise = held;
    return held;
  }

  private async openIdentity(): Promise<boolean> {
    const ownPk = await this.resolveOwnPk();
    if (ownPk === null || this.disposingFlag || this.tearingDownFlag) return false;
    if (this.current() === null) this.open(ownPk, undefined);
    return true;
  }

  /**
   * The confirm-account rebuild: the graph takes the confirmed `username`.
   * Deferred (and logged) while the engine runs or is paused; `true` once the
   * live graph carries the username. Concurrent opens wait for the rebuild.
   */
  async rebuildWith(username: string): Promise<boolean> {
    await this.settleBuild();
    const live = this.current();
    if (live === null || this.disposingFlag || this.tearingDownFlag) return false;
    if (live.ownUsername === username) return true;
    const state = live.engine.status().state;
    if (state === 'running' || state === 'paused') {
      logger.warn('foundation: confirmed username differs but the engine is active, deferring the rebuild', {
        username,
        state,
      });
      return false;
    }
    logger.info('foundation: own username confirmed, rebuilding graph', { from: live.ownUsername ?? '(unknown)', to: username });
    return this.memoize(this.teardown().then(() => {
      if (this.disposingFlag || this.tearingDownFlag || this.current() !== null) return false;
      this.open(live.ownPk, username);
      return true;
    }));
  }

  /** The open transition IS the wiring: every dependent declared over this session is built here. */
  private open(ownPk: string, ownUsername: string | undefined): void {
    this.mutable.open(this.deps.build(ownPk, ownUsername));
    logger.info('foundation: dependency graph built', { ownPk, ownUsername: this.current()?.ownUsername ?? '(unknown)' });
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
      this.deps.onIdentityChanged?.();
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
      logger.warn('foundation: in-flight build rejected while settling', {
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
