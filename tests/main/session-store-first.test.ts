/**
 * Store-first identity (spec §12.8): the graph opens from the store alone — the own username is the store's
 * own account row — and no read path ever navigates, evaluates in or presses on the tab. Only confirm-account
 * rebuilds, and only while the engine is idle.
 */

import type { InstagramTab } from '@/adapter/tab';
import type { Foundation } from '@/main/foundation-wiring';
import type { GraphSession } from '@/main/modules/session';
import type { BuiltGraph } from '@/main/services/graph-types';
import { cleanupMainHarness, foundationStore, makeFakeTab, newFoundation, tempUserData } from '../kit/main-harness';

afterAll(cleanupMainHarness);

/** A tab that counts every call a build or a read could make on it. */
function countingTab(): { tab: InstagramTab; touches: string[] } {
  const touches: string[] = [];
  const tab = makeFakeTab({
    show: () => { touches.push('show'); },
    hide: () => { touches.push('hide'); },
    goto: async (url: string) => { touches.push(`goto:${url}`); },
    evaluate: async <T>(): Promise<T> => { touches.push('evaluate'); return '/someone-else/' as T; },
  });
  return { tab, touches };
}

const sessionOf = (f: Foundation): GraphSession => (f as unknown as { session: GraphSession }).session;
const graphOf = (f: Foundation): BuiltGraph => {
  const g = sessionOf(f).current();
  if (g === null) throw new Error('no graph');
  return g;
};

test('the graph opens from the store with zero tab work, degraded when the store has no own username', async () => {
  const { tab, touches } = countingTab();
  const { foundation: f } = newFoundation({ tab });
  expect(await f.ensureBuilt()).toBe(true);
  expect(graphOf(f).ownUsername).toBeUndefined();
  expect(touches).toEqual([]);
  await f.dispose();
});

test("the own username is the store's own account row", async () => {
  const userDataDir = tempUserData();
  const first = newFoundation({ userDataDir });
  await first.foundation.ensureBuilt();
  foundationStore(first.foundation).observe({
    accountPk: '4242', observedAt: Date.now(), source: 'profile', fields: { username: 'owen' },
  });
  await first.foundation.dispose();

  const { tab, touches } = countingTab();
  const { foundation: f } = newFoundation({ userDataDir, tab });
  expect(await f.ensureBuilt()).toBe(true);
  expect(graphOf(f).ownUsername).toBe('owen');
  expect(touches).toEqual([]);
  await f.dispose();
});

test('no read path calls the tab: chainList, growthSeries, queueList and status', async () => {
  const { tab, touches } = countingTab();
  const { foundation: f } = newFoundation({ tab });
  await f.chainList();
  await f.growthSeries(14);
  await f.queueList('queued');
  await f.status();
  await f.chainList();
  expect(touches).toEqual([]);
  await f.dispose();
});

test('concurrent opens share one build', async () => {
  const { foundation: f } = newFoundation();
  const session = sessionOf(f);
  const [a, b, c] = await Promise.all([session.openFromStore(), session.openFromStore(), f.ensureBuilt()]);
  expect([a, b, c]).toEqual([true, true, true]);
  const graph = session.current();
  expect(await session.openFromStore()).toBe(true);
  expect(session.current()).toBe(graph);
  await f.dispose();
});

test('the tour hold no longer blocks the store open', async () => {
  const { tab, touches } = countingTab();
  const { foundation: f } = newFoundation({ tab });
  f.setTourHold(true);
  expect(await f.ensureBuilt()).toBe(true);
  expect(touches).toEqual([]);
  await f.dispose();
});

describe('rebuildWith (the confirm-account rebuild)', () => {
  test('an idle graph rebuilds with the confirmed username', async () => {
    const { foundation: f } = newFoundation();
    await f.ensureBuilt();
    const before = graphOf(f);
    expect(await sessionOf(f).rebuildWith('owen')).toBe(true);
    expect(graphOf(f)).not.toBe(before);
    expect(graphOf(f).ownUsername).toBe('owen');
    expect(graphOf(f).ownPk).toBe('4242');
    expect(await sessionOf(f).rebuildWith('owen')).toBe(true);
    await f.dispose();
  });

  test('an active engine defers the rebuild and keeps the graph', async () => {
    const { foundation: f } = newFoundation();
    await f.ensureBuilt();
    const graph = graphOf(f);
    jest.spyOn(graph.engine, 'status').mockReturnValue({ ...graph.engine.status(), state: 'running' });
    expect(await sessionOf(f).rebuildWith('owen')).toBe(false);
    expect(graphOf(f)).toBe(graph);
    jest.restoreAllMocks();
    await f.dispose();
  });

  test('an open racing the rebuild waits for it instead of opening a graph of its own', async () => {
    const { foundation: f } = newFoundation();
    await f.ensureBuilt();
    const rebuilding = sessionOf(f).rebuildWith('owen');
    const reading = f.chainList();
    expect(await rebuilding).toBe(true);
    await reading;
    expect(graphOf(f).ownUsername).toBe('owen');
    await f.dispose();
  });
});
