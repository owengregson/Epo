/**
 * Composition without a container.
 *
 * `foundation-wiring.ts` is not a god object — it is a **lifetime manager
 * wearing a facade**. It conflates four jobs: construction (what depends on
 * what), lifetime (what exists before login vs after), policy (who may drive
 * the tab), and projection (what gets pushed). This file owns the first two,
 * declaratively.
 *
 * A `Module` states its `id`, the modules it `needs`, and how to `build` a
 * value from them. `compose()` topologically sorts the reachable graph, builds
 * each module EXACTLY once, starts them in dependency order, and disposes them
 * in the exact REVERSE of the order they started. A cycle is an error raised
 * before a single `build()` runs; a failed `start()` unwinds what already
 * started, newest first.
 *
 * Deliberately NOT a DI container: containers resolve by name/token at
 * runtime, which throws away the compile-time dependency graph. `needs`
 * references the dependency MODULE directly, so the graph is typed, a missing
 * dependency is a type error, and `Composed.get(m)` is keyed on module
 * identity rather than a string.
 *
 * The kernel imports nothing from `src/` — `host` is a generic the application
 * instantiates (`src/main/app.ts` passes `{ userDataDir, igSession, … }`).
 *
 * See ADR 1007.
 */

/**
 * The three lifecycle verbs a built value may implement. All optional: a pure
 * value (a config projection, a port adapter) implements none and still
 * composes.
 *
 * `build` is CONSTRUCTION ONLY — it must not acquire a resource that only its
 * own `dispose` releases, because a module whose `start` throws is never
 * disposed (see {@link compose}). Acquire in `start`, release in `dispose`.
 */
export interface Lifetime {
  /** Begin doing work. Runs in dependency order (deps first). */
  start?(): Promise<void> | void;
  /** Quiesce without releasing: stop scheduling, keep state. Reverse order. */
  stop?(): Promise<void> | void;
  /** Release resources. Reverse of the order the module started. */
  dispose?(): Promise<void> | void;
}

/** The shape of a module's dependency record. */
export type Deps = Record<string, unknown>;

/** The dependency record of a module that needs nothing. */
export type NoDeps = Record<string, never>;

/**
 * A module of unknown dependency shape. Used wherever a dependency's OWN
 * dependencies are existential — `needs` only has to name a module producing
 * the right value, never restate how that module is built. `Deps` in that
 * position would force every consumer to restate the whole transitive graph in
 * its own type, so the escape hatch is confined to this one alias.
 */
// biome-ignore lint/suspicious/noExplicitAny: a dependency's dep record is existential (see above).
export type AnyModule<T, H = unknown> = Module<T, any, H>;

/**
 * A unit of composition: an id, the modules it needs, and a builder over the
 * values they produced plus the host environment.
 */
export interface Module<T, D extends Deps = NoDeps, H = unknown> {
  /** Stable identity, used in errors and in the composed order listing. */
  readonly id: string;
  /** Dependency name → the module producing that dependency's value. */
  readonly needs: { readonly [K in keyof D]: AnyModule<D[K], H> };
  /** Construct the value. Pure construction — acquire in `start`, not here. */
  build(deps: D, host: H): T & Partial<Lifetime>;
}

/** A started module graph. */
export interface Composed<H = unknown> {
  /** The value a module produced. Throws if the module is not in this graph. */
  get<T>(module: AnyModule<T, H>): T;
  /** Module ids in build (== start) order: every dependency before its dependent. */
  readonly order: readonly string[];
  /** Quiesce every module, newest first. Never throws. */
  stop(): Promise<void>;
  /** Release every module, in exact reverse of the start order. Idempotent. */
  dispose(): Promise<void>;
}

/** Raised when the reachable module graph contains a cycle. Nothing was built. */
export class ModuleCycleError extends Error {
  /** The ids on the cycle, in visit order, ending with the repeated id. */
  readonly cycle: readonly string[];
  constructor(cycle: readonly string[]) {
    super(`module cycle: ${cycle.join(' -> ')}`);
    this.name = 'ModuleCycleError';
    this.cycle = cycle;
  }
}

/** Raised when two DISTINCT modules in one graph claim the same id. */
export class DuplicateModuleIdError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`duplicate module id: ${id}`);
    this.name = 'DuplicateModuleIdError';
    this.id = id;
  }
}

/** Raised by {@link Composed.get} for a module outside the composed graph. */
export class UnknownModuleError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`module not composed: ${id}`);
    this.name = 'UnknownModuleError';
    this.id = id;
  }
}

export interface ComposeOptions {
  /**
   * Reported for every error thrown by a `stop`/`dispose`. Unwinding NEVER
   * aborts on a failure — one module refusing to release must not strand the
   * rest — so this is the only place such an error surfaces. The app wires it
   * to the logger; the kernel has none by construction.
   */
  onUnwindError?(id: string, phase: 'stop' | 'dispose', error: unknown): void;
}

interface Built<H> {
  readonly module: AnyModule<unknown, H>;
  readonly value: Partial<Lifetime>;
}

/**
 * Depth-first topological resolve: every dependency lands before its
 * dependent, each module appears exactly once, and a back-edge raises
 * {@link ModuleCycleError} — all BEFORE any `build()` runs.
 */
function resolve<H>(roots: readonly AnyModule<unknown, H>[]): AnyModule<unknown, H>[] {
  const order: AnyModule<unknown, H>[] = [];
  const state = new Map<AnyModule<unknown, H>, 'visiting' | 'done'>();
  const byId = new Map<string, AnyModule<unknown, H>>();
  const path: string[] = [];

  const visit = (m: AnyModule<unknown, H>): void => {
    const seen = state.get(m);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new ModuleCycleError([...path, m.id]);
    const clash = byId.get(m.id);
    if (clash !== undefined && clash !== m) throw new DuplicateModuleIdError(m.id);
    byId.set(m.id, m);
    state.set(m, 'visiting');
    path.push(m.id);
    for (const dep of Object.values(m.needs ?? {})) {
      visit(dep as AnyModule<unknown, H>);
    }
    path.pop();
    state.set(m, 'done');
    order.push(m);
  };

  for (const root of roots) visit(root);
  return order;
}

/** Run one lifecycle verb over an unwind list, newest first, swallowing errors. */
async function unwind<H>(
  list: readonly Built<H>[],
  phase: 'stop' | 'dispose',
  opts: ComposeOptions,
): Promise<void> {
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i] as Built<H>;
    try {
      await entry.value[phase]?.();
    } catch (e) {
      opts.onUnwindError?.(entry.module.id, phase, e);
    }
  }
}

/**
 * Build and start the module graph reachable from `roots`.
 *
 * Guarantees (each is a property test in `tests/kernel/module.test.ts`):
 * 1. every reachable module is built exactly once, dependencies first;
 * 2. `start()` runs in that same order, so a dependency is started before any
 *    module that needs it;
 * 3. `dispose()` runs in the exact reverse of the order modules started;
 * 4. if a `start()` throws, every module whose `start` had already COMPLETED is
 *    disposed, newest first, and the original error is rethrown;
 * 5. a cycle raises {@link ModuleCycleError} before anything is built.
 */
export async function compose<H>(
  roots: readonly AnyModule<unknown, H>[],
  host: H,
  opts: ComposeOptions = {},
): Promise<Composed<H>> {
  const order = resolve(roots);
  const values = new Map<AnyModule<unknown, H>, unknown>();
  const built: Built<H>[] = [];

  for (const module of order) {
    const deps: Deps = {};
    for (const [name, dep] of Object.entries(module.needs ?? {})) {
      deps[name] = values.get(dep as AnyModule<unknown, H>);
    }
    const value = module.build(deps, host) as Partial<Lifetime>;
    values.set(module, value);
    built.push({ module, value });
  }

  // Started-and-completed only: a module whose `start` threw is NOT disposed
  // (it never acquired — `build` is construction only, see `Lifetime`).
  const started: Built<H>[] = [];
  try {
    for (const entry of built) {
      await entry.value.start?.();
      started.push(entry);
    }
  } catch (e) {
    await unwind(started, 'dispose', opts);
    throw e;
  }

  let disposed = false;
  return {
    get<T>(module: AnyModule<T, H>): T {
      if (!values.has(module as AnyModule<unknown, H>)) throw new UnknownModuleError(module.id);
      return values.get(module as AnyModule<unknown, H>) as T;
    },
    order: order.map((m) => m.id),
    stop: () => unwind(started, 'stop', opts),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await unwind(started, 'dispose', opts);
    },
  };
}

/** Declare a module. A helper only — it exists so `needs` infers `D` for you. */
export function defineModule<T, D extends Deps = NoDeps, H = unknown>(
  module: Module<T, D, H>,
): Module<T, D, H> {
  return module;
}
