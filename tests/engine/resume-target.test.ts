import { peekResumeTarget } from '@/engine/resume-target';
import type { FrontierSource, SourceFrontierSnapshot } from '@/engine/source-frontier';
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

    expect(peekResumeTarget({ store })).toEqual({ pk: 'a' });
    expect(peekResumeTarget({ store: kitStore() })).toBeNull();
  });

  test("the frontier's resume pk wins when the store knows it", () => {
    const store = kitStore();
    store.addTarget({ accountPk: 'r', source: 'discovered', status: 'active', chainIndex: 1 });

    expect(peekResumeTarget({ store, frontier: frontier('r', source('n')) })).toEqual({ pk: 'r' });
  });

  test("the frontier's next source is picked without writing to the store", () => {
    const store = kitStore();
    store.addTarget({ accountPk: 'old', source: 'discovered', status: 'exhausted', chainIndex: 3 });

    const fresh = peekResumeTarget({ store, frontier: frontier('gone', source('new')) });
    expect(fresh).toEqual({ pk: 'new', ready: { source: 'discovered', existing: null } });
    expect(store.getTarget('new')).toBeNull();

    const revived = peekResumeTarget({ store, frontier: frontier(null, source('old')) });
    expect(revived?.ready?.existing?.status).toBe('exhausted');
    expect(store.getTarget('old')?.status).toBe('exhausted');
    expect(peekResumeTarget({ store, frontier: frontier(null, null) })).toBeNull();
  });
});
