import type { Foundation } from '@/main/foundation-wiring';
import type { BuiltGraph } from '@/main/services/graph-builder';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);
const graphOf = (f: Foundation): BuiltGraph => (f as unknown as { session: { current(): BuiltGraph } }).session.current();

test('manual writes carry an expected identity and settle exactly one durable action', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  graph.store.observe({ accountPk: '77', observedAt: Date.now(), source: 'profile', fields: { username: 'target' } });
  const note = jest.spyOn(graph, 'noteMutation');
  const follow = jest.spyOn(graph.churnActions, 'follow').mockImplementation(async (_name, pk, onDispatch) => {
    expect(pk).toBe('77');
    onDispatch?.();
    return { status: 'ok' };
  });
  expect(await foundation.followOne('target')).toEqual({ ok: true, username: 'target' });
  expect(follow).toHaveBeenCalledTimes(1);
  expect(note).toHaveBeenCalledTimes(1);
  expect(graph.store.actionCountSince(0)).toBe(1);
  expect(graph.store.getEdge(graph.ownPk, '77', 'follows')?.status).toBe('active');
  expect(graph.store.pendingEffectIntents()).toEqual([]);
  await foundation.dispose();
});

test.each(['simulated', 'already-in-state'] as const)('%s manual outcome never advances return probation', async (outcome) => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  graph.store.observe({ accountPk: '77', observedAt: Date.now(), source: 'profile', fields: { username: 'target' } });
  const note = jest.spyOn(graph, 'noteMutation');
  jest.spyOn(graph.churnActions, 'follow').mockResolvedValue(outcome === 'simulated'
    ? { status: 'simulated' } : { status: 'ok', alreadyInState: true });
  expect((await foundation.followOne('target')).ok).toBe(true);
  expect(note).not.toHaveBeenCalled();
  await foundation.dispose();
});

test('unknown targets are refused when a fresh profile cannot establish identity', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  const identity = jest.spyOn(graph, 'resolveIdentity');
  jest.spyOn(graph.profiles, 'visit').mockResolvedValue({ ok: false, kind: 'gone', detail: {} });
  const follow = jest.spyOn(graph.churnActions, 'follow');
  expect(await foundation.followOne('missing')).toMatchObject({ ok: false, reason: 'target-identity-unavailable' });
  expect(identity).toHaveBeenCalledWith('missing');
  expect(follow).not.toHaveBeenCalled();
  expect(graph.store.actionCountSince(0)).toBe(0);
  await foundation.dispose();
});

test('a manual operation cannot overlap another manual driver', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  graph.store.observe({ accountPk: '77', observedAt: Date.now(), source: 'profile', fields: { username: 'target' } });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let admitted!: () => void;
  const entered = new Promise<void>((resolve) => { admitted = resolve; });
  jest.spyOn(graph.churnActions, 'follow').mockImplementation(async () => {
    admitted();
    await blocked;
    return { status: 'simulated' };
  });
  const first = foundation.followOne('target');
  await entered;
  expect(await foundation.unfollowOne('target')).toMatchObject({ ok: false, reason: 'manual-running' });
  release();
  await first;
  await foundation.dispose();
});

test('manual reconciliation completes before a write without starting growth', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  graph.store.observe({ accountPk: '77', observedAt: Date.now(), source: 'profile', fields: { username: 'target' } });
  const sequence: string[] = [];
  jest.spyOn(graph, 'prepareMutation').mockImplementation(async () => { sequence.push('reconciled'); return true; });
  const start = jest.spyOn(graph.engine, 'start');
  jest.spyOn(graph.churnActions, 'follow').mockImplementation(async () => { sequence.push('acted'); return { status: 'simulated' }; });
  expect((await foundation.followOne('target')).ok).toBe(true);
  expect(sequence).toEqual(['reconciled', 'acted']);
  expect(start).not.toHaveBeenCalled();
  expect(foundation.runtimeSnapshot().desired).toBe('stopped');
  await foundation.dispose();
});

test('Stop during standalone reconciliation aborts admission before any mutation', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  let release!: (ready: boolean) => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  jest.spyOn(graph, 'prepareMutation').mockImplementation(() => {
    entered();
    return new Promise<boolean>((resolve) => { release = resolve; });
  });
  const follow = jest.spyOn(graph.churnActions, 'follow');
  const action = foundation.followOne('target');
  await preparing;
  const signal = (foundation as unknown as { driverSignal(): AbortSignal }).driverSignal();
  await foundation.stopEngine();
  expect(signal.aborted).toBe(true);
  release(true);
  expect(await action).toMatchObject({ ok: false, reason: 'reconciliation-incomplete' });
  expect(follow).not.toHaveBeenCalled();
  await foundation.dispose();
});
