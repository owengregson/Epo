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
 *
 * Two additions (spec §13, §15.2): a `dedupe` row pushes only when its shaped
 * JSON changed, and one expiry timer re-pushes every row at the earliest
 * instant a source declares, so a verdict that ages out moves with no write.
 */

import type { PushContract, PushMethod } from '@/ipc/contract';
import { MS_PER_DAY } from '@/kernel/units';
import { notBuiltFacts, notBuiltFeed } from '@/main/modules/not-built';
import type { FeedView } from '@/shared/feed';
import type { SettingsFacts } from '@/shared/settings-facts';
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
  /** The store-derived Settings facts (the settings core shapes them). */
  settingsFacts(): SettingsFacts;
  /** The live feed (the live-data stream shapes it). */
  feed(): FeedView;
  /** The earliest instant a shown verdict changes with no mutation; null when none. */
  expiresAt?(): number | null;
}

/** The two sources whose shapers land with their owning streams: honest not-built shapes until then. */
export const UNWIRED_SOURCES: Pick<ProjectionSource, 'settingsFacts' | 'feed'> = {
  settingsFacts: () => notBuiltFacts('loading'),
  feed: () => notBuiltFeed(Date.now()),
};

/** One row of the registry: a push channel and how to shape its payload. */
export interface Projection<C extends PushMethod> {
  readonly channel: C;
  shape(source: ProjectionSource): PushContract[C];
  /** Push only when the shaped payload's JSON differs from this row's last push. */
  readonly dedupe?: boolean;
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
  { channel: 'settingsFacts', shape: (s) => s.settingsFacts() },
  { channel: 'feed', shape: (s) => s.feed(), dedupe: true },
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
  /** The wall clock the expiry timer measures against. */
  now?: () => number;
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
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The one timer armed at the earliest instant a source declared (see {@link armExpiry}). */
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private source: ProjectionSource | null = null;
  private stopped = false;
  /** The last pushed JSON of each deduplicated row. */
  private readonly lastPushed = new Map<PushMethod, string>();

  constructor(deps: ProjectionsDeps = {}) {
    this.push = deps.push;
    this.throttleMs = deps.throttleMs ?? POLL.GRAPH_PUSH_THROTTLE_MS;
    this.now = deps.now ?? (() => Date.now());
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

  /** Push every projection now, off the throttle, then re-arm the expiry timer. */
  pushAll(): void {
    const source = this.source;
    if (source === null || this.stopped) return;
    for (const projection of PROJECTIONS) {
      const payload = projection.shape(source);
      if ('dedupe' in projection && projection.dedupe) {
        const json = JSON.stringify(payload);
        if (this.lastPushed.get(projection.channel) === json) continue;
        this.lastPushed.set(projection.channel, json);
      }
      this.push?.(projection.channel, payload);
    }
    this.armExpiry(source);
  }

  /**
   * One timer at the earliest instant a shown verdict changes with no mutation (the census freshness end, the
   * plan-day roll), never sooner than the throttle and never longer than a day. An instant at or before now was
   * already reflected by the push that just ran, so it arms nothing and can never loop.
   */
  private armExpiry(source: ProjectionSource): void {
    this.clearExpiry();
    const at = source.expiresAt?.() ?? null;
    const now = this.now();
    if (at === null || !(at > now)) return;
    this.expiry = setTimeout(() => {
      this.expiry = null;
      this.pushAll();
    }, Math.min(Math.max(at - now, this.throttleMs), MS_PER_DAY));
  }

  private clearExpiry(): void {
    if (this.expiry === null) return;
    clearTimeout(this.expiry);
    this.expiry = null;
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
    this.lastPushed.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearExpiry();
    this.source = null;
  }

  /** Terminal: unbind and refuse every further push (app shutdown). */
  dispose(): void {
    this.unbind();
    this.stopped = true;
  }
}
