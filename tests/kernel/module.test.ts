/**
 * The ordering laws of `compose()` — the whole point of the module graph.
 *
 * These are stated as PROPERTIES over randomly generated DAGs rather than as
 * assertions about one hand-drawn graph: "dependencies start first" and
 * "dispose is the exact reverse of start" have to hold for every shape the
 * app will ever grow into, including diamonds (a module reachable by two
 * paths must still be built once).
 */

import fc from 'fast-check';
import {
  type AnyModule,
  compose,
  DuplicateModuleIdError,
  defineModule,
  ModuleCycleError,
  UnknownModuleError,
} from '@/kernel/module';

/** A DAG as adjacency lists: node `i` may only depend on nodes `< i`. */
const dagArb = fc
  .integer({ min: 1, max: 8 })
  .chain((n) =>
    fc.tuple(
      fc.constant(n),
      fc.tuple(
        ...Array.from({ length: n }, (_, i) =>
          fc.subarray(Array.from({ length: i }, (_, j) => j)),
        ),
      ),
    ),
  );

interface Trace {
  built: string[];
  started: string[];
  stopped: string[];
  disposed: string[];
}

/** Turn an adjacency list into modules that record every lifecycle call. */
function modulesFor(
  edges: readonly (readonly number[])[],
  trace: Trace,
  failStartAt?: number,
): AnyModule<unknown, void>[] {
  const built: AnyModule<unknown, void>[] = [];
  edges.forEach((deps, i) => {
    const id = `m${i}`;
    const needs: Record<string, AnyModule<unknown, void>> = {};
    deps.forEach((d, k) => {
      needs[`d${k}`] = built[d] as AnyModule<unknown, void>;
    });
    const module: AnyModule<unknown, void> = {
      id,
      needs,
      build: () => {
        trace.built.push(id);
        return {
          start: () => {
            if (i === failStartAt) throw new Error(`start failed: ${id}`);
            trace.started.push(id);
          },
          stop: () => {
            trace.stopped.push(id);
          },
          dispose: () => {
            trace.disposed.push(id);
          },
        };
      },
    };
    built.push(module);
  });
  return built;
}

const emptyTrace = (): Trace => ({ built: [], started: [], stopped: [], disposed: [] });

test('every reachable module is built exactly once, dependencies first', async () => {
  await fc.assert(
    fc.asyncProperty(dagArb, async ([n, edges]) => {
      const trace = emptyTrace();
      const mods = modulesFor(edges, trace);
      const composed = await compose([mods[n - 1] as AnyModule<unknown, void>, ...mods], undefined, {});
      expect(new Set(trace.built).size).toBe(trace.built.length);
      expect(trace.built).toHaveLength(n);
      for (const [i, deps] of edges.entries()) {
        for (const d of deps) {
          expect(trace.built.indexOf(`m${d}`)).toBeLessThan(trace.built.indexOf(`m${i}`));
        }
      }
      expect(composed.order).toEqual(trace.built);
      await composed.dispose();
    }),
    { numRuns: 60 },
  );
});

test('start runs in dependency order; dispose is its exact reverse', async () => {
  await fc.assert(
    fc.asyncProperty(dagArb, async ([, edges]) => {
      const trace = emptyTrace();
      const mods = modulesFor(edges, trace);
      const composed = await compose(mods, undefined, {});
      expect(trace.started).toEqual(trace.built);
      for (const [i, deps] of edges.entries()) {
        for (const d of deps) {
          expect(trace.started.indexOf(`m${d}`)).toBeLessThan(trace.started.indexOf(`m${i}`));
        }
      }
      await composed.dispose();
      expect(trace.disposed).toEqual([...trace.started].reverse());
    }),
    { numRuns: 60 },
  );
});

test('a failed start disposes exactly the modules that had started, newest first', async () => {
  await fc.assert(
    fc.asyncProperty(
      dagArb.chain(([n, edges]) =>
        fc.tuple(fc.constant(edges), fc.integer({ min: 0, max: n - 1 })),
      ),
      async ([edges, failAt]) => {
        const trace = emptyTrace();
        const mods = modulesFor(edges, trace, failAt);
        await expect(compose(mods, undefined, {})).rejects.toThrow('start failed');
        // The failing module never completed `start`, so it is not disposed;
        // everything before it is, newest first.
        expect(trace.disposed).toEqual([...trace.started].reverse());
        expect(trace.started).not.toContain(`m${failAt}`);
      },
    ),
    { numRuns: 60 },
  );
});

test('a cycle is a build-time error — nothing is built', async () => {
  const trace = emptyTrace();
  const mk = (id: string): AnyModule<unknown, void> => ({
    id,
    needs: {},
    build: () => {
      trace.built.push(id);
      return {};
    },
  });
  const a = mk('a') as { needs: Record<string, unknown> } & AnyModule<unknown, void>;
  const b = mk('b') as { needs: Record<string, unknown> } & AnyModule<unknown, void>;
  a.needs = { b };
  b.needs = { a };

  await expect(compose([a], undefined, {})).rejects.toThrow(ModuleCycleError);
  expect(trace.built).toEqual([]);
});

test('two distinct modules may not share an id', async () => {
  const one = defineModule({ id: 'same', needs: {}, build: () => ({}) });
  const two = defineModule({ id: 'same', needs: {}, build: () => ({}) });
  await expect(compose([one, two], undefined, {})).rejects.toThrow(DuplicateModuleIdError);
});

test('values are keyed on module identity and dependencies arrive by name', async () => {
  const clock = defineModule({ id: 'clock', needs: {}, build: () => ({ now: () => 7 }) });
  const reader = defineModule({
    id: 'reader',
    needs: { clock },
    build: (deps: { clock: { now(): number } }) => ({ read: () => deps.clock.now() * 2 }),
  });
  const composed = await compose([reader], undefined, {});
  expect(composed.get(reader).read()).toBe(14);
  expect(composed.get(clock).now()).toBe(7);
  const stranger = defineModule({ id: 'stranger', needs: {}, build: () => ({}) });
  expect(() => composed.get(stranger)).toThrow(UnknownModuleError);
  await composed.dispose();
});

test('the host environment reaches every builder', async () => {
  const seen: string[] = [];
  const leaf = defineModule<{ v: number }, Record<string, never>, { dir: string }>({
    id: 'leaf',
    needs: {},
    build: (_deps, host) => {
      seen.push(host.dir);
      return { v: 1 };
    },
  });
  const composed = await compose([leaf], { dir: '/tmp/epo' }, {});
  expect(seen).toEqual(['/tmp/epo']);
  await composed.dispose();
});

test('dispose is idempotent and an unwind failure never strands the rest', async () => {
  const disposed: string[] = [];
  const errors: [string, string][] = [];
  const good = defineModule({
    id: 'good',
    needs: {},
    build: () => ({
      dispose: () => {
        disposed.push('good');
      },
    }),
  });
  const bad = defineModule({
    id: 'bad',
    needs: { good },
    build: () => ({
      dispose: () => {
        throw new Error('nope');
      },
    }),
  });
  const composed = await compose([bad], undefined, {
    onUnwindError: (id, phase) => errors.push([id, phase]),
  });
  await composed.dispose();
  await composed.dispose();
  expect(disposed).toEqual(['good']);
  expect(errors).toEqual([['bad', 'dispose']]);
});

test('stop quiesces newest-first without disposing', async () => {
  const trace = emptyTrace();
  const mods = modulesFor([[], [0], [1]], trace);
  const composed = await compose(mods, undefined, {});
  await composed.stop();
  expect(trace.stopped).toEqual(['m2', 'm1', 'm0']);
  expect(trace.disposed).toEqual([]);
  await composed.dispose();
  expect(trace.disposed).toEqual(['m2', 'm1', 'm0']);
});
