import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Foundation } from '@/main/foundation-wiring';
import type { BuiltGraph } from '@/main/services/graph-builder';
import type { RuntimeCoordinator } from '@/main/services/runtime-coordinator';
import type { TabLease } from '@/main/services/tab-lease';
import { RECOVERY } from '@/timing/config';
import { cleanupMainHarness, makeFakeTab, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const internal = (f: Foundation) => f as unknown as {
  session: { current(): BuiltGraph };
  lease: TabLease;
  runtime: RuntimeCoordinator;
  driverSignal(): AbortSignal;
  checkEngineStepWatchdog(): Promise<void> | void;
  maybeRunScheduledPrune(): Promise<void>;
  recoverWedgedEngine(): Promise<void>;
};

async function running(over: Parameters<typeof newFoundation>[0] = {}) {
  const h = newFoundation(over);
  await h.foundation.updateSettings({ activeHoursStart: 8, activeHoursEnd: 8, pacingModel: 'legacy' });
  await h.foundation.startEngine();
  await flush();
  return h;
}

test('offline before graph creation is inherited by the engine', async () => {
  const { foundation } = newFoundation();
  foundation.setConnectivity(false);
  await foundation.ensureBuilt();
  expect((await foundation.status()).online).toBe(false);
  await foundation.dispose();
});

test('an offline wait never triggers renderer recovery', async () => {
  const recoverTab = jest.fn(async () => {});
  const { foundation } = await running({ tab: makeFakeTab({ recoverTab }) });
  foundation.setConnectivity(false);
  await flush();
  const i = internal(foundation);
  expect(i.session.current().delays.pending()).toEqual([]);
  const old = jest.spyOn(i.runtime, 'snapshot').mockReturnValue({
    ...i.runtime.snapshot(), lastProgressAt: Date.now() - RECOVERY.STEP_WATCHDOG_MS - 1,
  });
  await i.checkEngineStepWatchdog();
  expect(recoverTab).not.toHaveBeenCalled();
  old.mockRestore();
  await foundation.dispose();
});

test('prune returns growth ownership and its cancellation signal', async () => {
  const { foundation } = await running();
  const i = internal(foundation);
  jest.spyOn(i.session.current().pruneEngine, 'scan').mockResolvedValue({ following: 0, followers: 0, candidates: [], aborted: false });
  expect((await foundation.scanPrune()).ok).toBe(true);
  expect(i.lease.owner()).toBe('growth');
  const signal = i.driverSignal();
  expect(i.driverSignal()).toBe(signal);
  await foundation.stopEngine();
  expect(signal.aborted).toBe(true);
  await foundation.dispose();
});

test('prune preparation gets a fresh signal after an old stop, and can itself be stopped', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const i = internal(foundation);
  const graph = i.session.current();
  graph.pruneEngine.stop();
  expect(graph.pruneEngine.runSignal().aborted).toBe(true);
  let finish!: (ready: boolean) => void;
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  jest.spyOn(graph, 'prepareMutation').mockImplementation(() => {
    expect(i.driverSignal().aborted).toBe(false);
    entered();
    return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  const run = jest.spyOn(graph.pruneEngine, 'run');
  const request = foundation.startPrune();
  await preparing;
  const signal = i.driverSignal();
  expect(i.driverSignal()).toBe(signal);
  await foundation.stopPrune();
  expect(signal.aborted).toBe(true);
  finish(true);
  expect(await request).toMatchObject({ ok: false, reason: 'reconciliation-incomplete' });
  expect(run).not.toHaveBeenCalled();
  expect(i.lease.owner()).toBeNull();
  expect(foundation.runtimeSnapshot().desired).toBe('stopped');
  await foundation.dispose();
});

test('incomplete standalone prune preparation returns its borrowed growth lease', async () => {
  const { foundation } = await running();
  const i = internal(foundation);
  jest.spyOn(i.session.current(), 'prepareMutation').mockResolvedValue(false);
  expect(await foundation.startPrune()).toMatchObject({ ok: false, reason: 'reconciliation-incomplete' });
  expect(i.lease.owner()).toBe('growth');
  expect((await foundation.status()).state).toBe('running');
  await foundation.dispose();
});

test('restart from a seed discards the old durable source portfolio', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = internal(foundation).session.current();
  const status = await foundation.status();
  graph.store.setSourceFrontierState(JSON.stringify({ version: 1, currentTargetPk: null,
    sources: [], recentFollowSources: ['old'], totalFollows: 12 }));
  jest.spyOn(foundation, 'startEngine').mockResolvedValue(status);
  await foundation.restartFromSeed('newseed');
  expect(graph.store.getSourceFrontierState()).toBeNull();
  await foundation.dispose();
});

test('Stop also revokes a seed restart waiting for an old loop to drain', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = internal(foundation).session.current();
  let release!: () => void;
  graph.enginePromise = new Promise<void>((resolve) => { release = resolve; });
  const start = jest.spyOn(foundation, 'startEngine');
  const restart = foundation.restartFromSeed('newseed');
  await flush();
  await foundation.stopEngine();
  release();
  expect(await restart).toMatchObject({ refusal: 'runtime-intent-changed' });
  expect(start).not.toHaveBeenCalled();
  await foundation.dispose();
});

test('a user Stop during wake prevents automatic restart', async () => {
  const { foundation } = await running({ tab: makeFakeTab({ checkHealth: async () => ({ healthy: true }) }) });
  foundation.suspendForSleep();
  await flush();
  const wake = foundation.resumeFromSleep({ settleMsOverride: 10 });
  await foundation.stopEngine();
  await wake;
  expect((await foundation.status()).state).toBe('idle');
  expect(foundation.runtimeSnapshot()).toMatchObject({ desired: 'stopped', phase: 'ready' });
  await foundation.dispose();
});

test('a thrown wake canary leaves a visible durable block, not an idle unexplained run', async () => {
  const { foundation } = await running({ tab: makeFakeTab({ checkHealth: async () => { throw new Error('CDP gone'); } }) });
  foundation.suspendForSleep();
  await foundation.resumeFromSleep({ settleMsOverride: 0 });
  expect(foundation.runtimeSnapshot()).toMatchObject({ desired: 'running', phase: 'ready', blockedReason: 'wake-reconciliation-failed' });
  expect((await foundation.status()).state).toBe('idle');
  await foundation.dispose();
});

test.each([false, true])('a second sleep/wake during reconciliation is rechecked; Stop=%s is preserved', async (stop) => {
  let resolveHealth!: (health: { healthy: boolean }) => void;
  let entered!: () => void;
  const checking = new Promise<void>((resolve) => { entered = resolve; });
  const checkHealth = jest.fn(async () => ({ healthy: true })).mockImplementationOnce(() => {
    entered();
    return new Promise((resolve) => { resolveHealth = resolve; });
  });
  const { foundation } = await running({ tab: makeFakeTab({ checkHealth }) });
  foundation.suspendForSleep();
  const first = foundation.resumeFromSleep({ settleMsOverride: 0 });
  await checking;
  foundation.suspendForSleep();
  const second = foundation.resumeFromSleep({ settleMsOverride: 0 });
  if (stop) await foundation.stopEngine();
  resolveHealth({ healthy: true });
  await Promise.all([first, second]);
  expect(checkHealth).toHaveBeenCalledTimes(2);
  expect(foundation.runtimeSnapshot()).toMatchObject({ phase: 'ready', blockedReason: null,
    desired: stop ? 'stopped' : 'running' });
  expect((await foundation.status()).state).toBe(stop ? 'idle' : 'running');
  await foundation.dispose();
});

test('status reads and passive observations cannot disguise a stuck autonomous operation', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = internal(foundation).session.current();
  const progress = jest.spyOn(internal(foundation).runtime, 'progress');
  const before = foundation.runtimeSnapshot().lastProgressAt;
  await foundation.status();
  expect(foundation.runtimeSnapshot().lastProgressAt).toBe(before);
  graph.store.observeEdge(graph.ownPk, '1234', 'follows', true, Date.now());
  expect(foundation.runtimeSnapshot().lastProgressAt).toBe(before);
  expect(progress).not.toHaveBeenCalled();
  await foundation.dispose();
});

test('sleep revokes every driver signal and stops prune', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const i = internal(foundation);
  i.lease.claim('prune');
  const signal = i.driverSignal();
  const stop = jest.spyOn(i.session.current().pruneEngine, 'stop');
  foundation.suspendForSleep();
  expect(signal.aborted).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  expect((await foundation.startPrune()).ok).toBe(false);
  await foundation.dispose();
});

test('identity changes revoke intent and rebuild into an isolated database', async () => {
  const { foundation, session, userDataDir } = newFoundation();
  await foundation.ensureBuilt();
  const original = internal(foundation).session.current();
  session.setDsUserId('5555');
  await foundation.ensureBuilt();
  const next = internal(foundation).session.current();
  expect(next).not.toBe(original);
  expect(next.ownPk).toBe('5555');
  expect(foundation.runtimeSnapshot().blockedReason).toBe('account-changed');
  expect(fs.existsSync(path.join(userDataDir, 'epo-account-5555.db'))).toBe(true);
  await foundation.dispose();
});

test('a deliberate quit persists stopped intent across the next launch', async () => {
  const { foundation, userDataDir } = await running();
  foundation.shutdownRuntime();
  await foundation.dispose();
  const next = newFoundation({ userDataDir }).foundation;
  await next.restoreRuntimeIntent();
  expect((await next.status()).state).toBe('idle');
  expect(next.runtimeSnapshot().desired).toBe('stopped');
  await next.dispose();
});

test('an interrupted running intent resumes on relaunch after identity validation', async () => {
  const { foundation, userDataDir } = await running();
  // Dispose releases test resources without going through intentional Quit.
  await foundation.dispose();
  const next = newFoundation({ userDataDir }).foundation;
  await next.restoreRuntimeIntent();
  expect((await next.status()).state).toBe('running');
  await next.stopEngine();
  await next.dispose();
});

test('Stop during watchdog repair is never undone', async () => {
  let complete!: () => void;
  const recoverTab = jest.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const { foundation } = await running({ tab: makeFakeTab({ recoverTab }) });
  const repair = internal(foundation).recoverWedgedEngine();
  await flush();
  await foundation.stopEngine();
  complete();
  await repair;
  expect((await foundation.status()).state).toBe('idle');
  expect(foundation.runtimeSnapshot().desired).toBe('stopped');
  await foundation.dispose();
});

test('scheduled maintenance can borrow from continuously running growth', async () => {
  const { foundation } = await running();
  await foundation.updateSettings({ pruneScheduleDays: 1, pruneLastRunAt: null });
  const graph = internal(foundation).session.current();
  jest.spyOn(graph.rate, 'withinActiveHours').mockReturnValue(false).mockReturnValueOnce(true).mockReturnValueOnce(true);
  const run = jest.spyOn(graph.pruneEngine, 'run').mockResolvedValue(undefined);
  const random = jest.spyOn(Math, 'random').mockReturnValue(0);
  await internal(foundation).maybeRunScheduledPrune();
  await flush();
  expect(run).toHaveBeenCalledTimes(1);
  expect(internal(foundation).lease.owner()).toBe('growth');
  random.mockRestore();
  await foundation.dispose();
});

test('wake defers growth until an interrupted prune scan actually drains', async () => {
  const { foundation } = await running({ tab: makeFakeTab({ checkHealth: async () => ({ healthy: true }) }) });
  const graph = internal(foundation).session.current();
  let entered!: () => void;
  const scanning = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: () => void;
  jest.spyOn(graph.pruneEngine, 'scan').mockImplementation(async () => {
    entered();
    await new Promise<void>((resolve) => { finish = resolve; });
    return { following: 0, followers: 0, candidates: [], aborted: true };
  });
  const scan = foundation.scanPrune();
  await scanning;
  foundation.suspendForSleep();
  await flush();
  await foundation.resumeFromSleep({ settleMsOverride: 0 });
  expect((await foundation.status()).state).toBe('idle');
  finish();
  expect((await scan).ok).toBe(false);
  await flush();
  expect((await foundation.status()).state).toBe('running');
  expect(internal(foundation).lease.owner()).toBe('growth');
  await foundation.dispose();
});
