/**
 * The projections registry — PRINCIPLES §2 made mechanical.
 *
 * "The UI mirrors the graph, live" has ONE mechanism: the store fires
 * `onMutation` after every write, a trailing throttle coalesces the burst, and
 * every renderer-facing projection is re-shaped and pushed. Before this file
 * that mechanism was spelled out five times — three `FoundationDeps`
 * callbacks, one throttle timer, one hand-written push body — so adding a live
 * projection meant remembering five edits, and forgetting one produced a
 * number that only moved when an operation ENDED (the §2 violation the
 * principle exists to name).
 *
 * Here it is a table. One `store.onMutation` subscription, one trailing
 * throttle, one loop over `PROJECTIONS`. Adding a live projection is one row.
 *
 * Behaviour is bit-identical to the code it replaces: the same throttle
 * constant, the same trailing (never leading) edge, the same "push all three
 * fresh the moment the graph exists" opening push, and the same guard that a
 * timer which fires after teardown pushes nothing. `tests/main/*` are the
 * oracle.
 */

import type { PushContract, PushMethod } from '@/ipc/contract';
import { POLL } from '@/timing/config';
import type { ChainTargetView, EpoStatus, PruneStatus } from '@/types';

/** The renderer push seam: main wires this to `shell.send` through `PUSH`. */
export type PushFn = <C extends PushMethod>(channel: C, payload: PushContract[C]) => void;

/**
 * Everything the registry needs to shape a push. Each member reads the LIVE
 * graph — the registry never caches a projection, so a push always carries the
 * store's current answer rather than a value captured when the burst started.
 */
export interface ProjectionSource {
  status(): EpoStatus;
  pruneStatus(): PruneStatus;
  chainList(): ChainTargetView[];
}

/** One row of the registry: a push channel and how to shape its payload. */
export interface Projection<C extends PushMethod> {
  readonly channel: C;
  shape(source: ProjectionSource): PushContract[C];
}

/**
 * The union of exactly-typed rows. A row whose `shape` returns the wrong
 * payload for its `channel` fails the `satisfies` below — the drift guard the
 * three hand-written callbacks never had.
 */
type AnyProjection = { [C in PushMethod]: Projection<C> }[PushMethod];

/**
 * THE TABLE. Every mutation-driven projection, in push order.
 *
 * `chainList` must ride THIS push (not a status-counter-keyed refetch in the
 * renderer): a pure acquisition walk writes accounts and edges only — no
 * status counter moves — so a counter-keyed pull would stay frozen exactly
 * during the operation whose liveness §2 mandates.
 *
 * `log` and `updateStatus` are NOT here: neither derives from the knowledge
 * graph, so neither belongs on a store-mutation push.
 */
export const PROJECTIONS = [
  { channel: 'status', shape: (s) => s.status() },
  { channel: 'pruneStatus', shape: (s) => s.pruneStatus() },
  { channel: 'chainList', shape: (s) => s.chainList() },
] as const satisfies readonly AnyProjection[];

/** The one store surface the registry subscribes to. */
export interface MutationSource {
  onMutation(listener: () => void): () => void;
}

export interface ProjectionsDeps {
  /** Where a shaped projection goes. Absent in tests that assert nothing. */
  push?: PushFn;
  /** Trailing coalescing window. Defaults to the shared graph-push throttle. */
  throttleMs?: number;
}

/**
 * The live push machinery for one built graph.
 *
 * Constructed at graph build, disposed at graph teardown — so its subscription
 * and its pending timer have exactly the lifetime of the graph they mirror,
 * which is what the kernel `Session` binding gives every dependent for free.
 */
export class Projections {
  private readonly push?: PushFn;
  private readonly throttleMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private source: ProjectionSource | null = null;
  private stopped = false;

  constructor(deps: ProjectionsDeps = {}) {
    this.push = deps.push;
    this.throttleMs = deps.throttleMs ?? POLL.GRAPH_PUSH_THROTTLE_MS;
  }

  /**
   * Subscribe to the store and push one fresh set immediately.
   *
   * The opening push is load-bearing: the renderer's first status pull races
   * the lazy graph build and gets the all-zero not-built shape, and an idle
   * engine emits nothing on its own — without it the queue/prune counts stay
   * wrong until a keep-alive pull happens to land after the build.
   */
  bind(store: MutationSource, source: ProjectionSource): void {
    this.source = source;
    this.unsub = store.onMutation(() => this.schedule());
    this.pushAll();
  }

  /** Push every projection now, off the throttle. */
  pushAll(): void {
    const source = this.source;
    if (source === null || this.stopped) return;
    for (const projection of PROJECTIONS) {
      this.push?.(projection.channel, projection.shape(source));
    }
  }

  /** Push ONE projection now (the engine's own status emit path). */
  send<C extends PushMethod>(channel: C, payload: PushContract[C]): void {
    if (this.stopped) return;
    this.push?.(channel, payload);
  }

  /**
   * Trailing throttle: the first mutation of a burst arms the timer, every
   * later one inside the window is absorbed, and the push happens once at the
   * end with the store's state as of THEN.
   */
  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pushAll();
    }, this.throttleMs);
  }

  /**
   * Drop the subscription and any armed timer. Ran on the session's CLOSE
   * transition — i.e. before the store closes — so a late write from a
   * draining op can never schedule a push that reads a closed handle.
   *
   * `send` keeps working: the not-built status pushed on a connectivity change
   * has no graph behind it and must still reach the renderer.
   */
  unbind(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.source = null;
  }

  /** Terminal: unbind and refuse every further push (app shutdown). */
  dispose(): void {
    this.unbind();
    this.stopped = true;
  }
}
