import fc from 'fast-check';
import { peekResumeTarget } from '@/engine/resume-target';
import { type FrontierSource, SourceFrontier, type SourceFrontierSnapshot } from '@/engine/source-frontier';
import { TargetPipeline, type TargetPipelineDeps } from '@/engine/target-pipeline';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Target } from '@/store/types';
import { kitStore } from '../kit/engine-harness';

/** A frontier stub: a fixed resume pk and a fixed next source. */
const frontier = (currentTargetPk: string | null, next: FrontierSource | null) => ({
  snapshot: () => ({ currentTargetPk }) as SourceFrontierSnapshot,
  next: () => next,
});

const source = (pk: string): FrontierSource => ({
  pk, source: 'discovered', status: 'ready', resumeAt: 0, lastVisitedAt: 0, totalFollows: 0, visit: null, lastReason: null,
});

describe('peekResumeTarget', () => {
  test('without a frontier: the active target with the highest chain index, ties to the lower pk', () => {
    const store = kitStore();
    store.addTarget({ accountPk: 'b', source: 'discovered', status: 'active', chainIndex: 2 });
    store.addTarget({ accountPk: 'a', source: 'discovered', status: 'active', chainIndex: 2 });
    store.addTarget({ accountPk: 'z', source: 'seed', status: 'active', chainIndex: 0 });
    store.addTarget({ accountPk: 'x', source: 'discovered', status: 'exhausted', chainIndex: 9 });

    expect(peekResumeTarget({ store })).toEqual({ pk: 'a', via: 'chain' });
    expect(peekResumeTarget({ store: kitStore() })).toBeNull();
  });

  test("the frontier's resume pk wins when the store knows it", () => {
    const store = kitStore();
    store.addTarget({ accountPk: 'r', source: 'discovered', status: 'active', chainIndex: 1 });

    expect(peekResumeTarget({ store, frontier: frontier('r', source('n')) })).toEqual({ pk: 'r', via: 'current' });
  });

  test("the frontier's next source is picked without writing to the store", () => {
    const store = kitStore();
    store.addTarget({ accountPk: 'old', source: 'discovered', status: 'exhausted', chainIndex: 3 });

    const fresh = peekResumeTarget({ store, frontier: frontier('gone', source('new')) });
    expect(fresh).toEqual({ pk: 'new', via: 'frontier', ready: { source: 'discovered', existing: null } });
    expect(store.getTarget('new')).toBeNull();

    const revived = peekResumeTarget({ store, frontier: frontier(null, source('old')) });
    expect(revived?.ready?.existing?.status).toBe('exhausted');
    expect(store.getTarget('old')?.status).toBe('exhausted');
    expect(peekResumeTarget({ store, frontier: frontier(null, null) })).toBeNull();
  });
});

/** Every store method that writes, spied, so a peek can prove it wrote nothing. */
function writeSpies(store: KnowledgeStore): jest.SpyInstance[] {
  const proto = Object.getPrototypeOf(store) as Record<string, unknown>;
  const names = new Set<string>();
  for (let p: object | null = proto; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (/^(set|add|upsert|observe|save|record|clear|delete|mark|begin|settle|prune|ensure|retire|reconcile|apply)/.test(name)) names.add(name);
    }
  }
  return [...names].map((name) => jest.spyOn(store as unknown as Record<string, () => unknown>, name));
}

/** The pipeline over a real store and frontier; only adoption runs, so every other dep is inert. */
function pipelineOver(store: KnowledgeStore, frontierPort: SourceFrontier | undefined): TargetPipeline {
  const inert = {} as never;
  const deps: TargetPipelineDeps = {
    store, clock: { now: () => 1_000_000 } as never, acquisition: inert, scanner: inert, enricher: inert,
    frontier: frontierPort, settings: () => inert, wait: inert, recover: inert, halt: inert,
  };
  return new TargetPipeline(deps);
}

describe('L-RESUME', () => {
  const arbTarget = fc.record({
    n: fc.integer({ min: 0, max: 6 }),
    status: fc.constantFrom('active', 'exhausted', 'retained', 'retired') as fc.Arbitrary<Target['status']>,
    chainIndex: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
    named: fc.boolean(),
  });
  const arbSource = fc.record({
    n: fc.integer({ min: 0, max: 8 }),
    status: fc.constantFrom('ready', 'working', 'deferred', 'verified-ended') as fc.Arbitrary<FrontierSource['status']>,
    due: fc.boolean(),
    totalFollows: fc.integer({ min: 0, max: 5 }),
  });
  const arbState = fc.record({
    targets: fc.array(arbTarget, { maxLength: 6 }),
    sources: fc.option(fc.array(arbSource, { maxLength: 6 }), { nil: null }),
    current: fc.option(fc.integer({ min: 0, max: 8 }), { nil: null }),
    withFrontier: fc.boolean(),
  });

  test('peek = adopt: the pick is exactly what a start adopts, and the peek writes nothing', () => {
    fc.assert(fc.property(arbState, (g) => {
      const store = kitStore();
      const now = 1_000_000;
      for (const t of g.targets) {
        if (store.getTarget(`p${t.n}`) !== null) continue;
        store.addTarget({ accountPk: `p${t.n}`, source: 'discovered', status: t.status, chainIndex: t.chainIndex });
        if (t.named) store.observe({ accountPk: `p${t.n}`, observedAt: now, source: 'profile', fields: { username: `u${t.n}` } });
      }
      if (g.sources !== null) {
        const sources = [...new Map(g.sources.map((s) => [s.n, s])).values()].map((s) => {
          store.observe({ accountPk: `p${s.n}`, observedAt: now, source: 'profile', fields: { username: `u${s.n}` } });
          return { ...source(`p${s.n}`), status: s.status, resumeAt: s.due ? now - 1 : now + 1, totalFollows: s.totalFollows };
        });
        const snapshot: SourceFrontierSnapshot = { version: 1, currentTargetPk: g.current === null ? null : `p${g.current}`,
          sources, recentFollowSources: [], totalFollows: 0 };
        store.setSourceFrontierState(JSON.stringify(snapshot));
      }
      const port = g.withFrontier ? new SourceFrontier({ store, clock: { now: () => now } as never }) : undefined;
      const spies = writeSpies(store);
      const pick = peekResumeTarget({ store, frontier: port });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      for (const spy of spies) spy.mockRestore();

      const pipeline = pipelineOver(store, port);
      expect(pipeline.adoptActiveTargetFromStore()).toBe(pick !== null);
      expect(pipeline.current?.pk ?? null).toBe(pick?.pk ?? null);
      store.close();
    }), { numRuns: 120 });
  });
});
