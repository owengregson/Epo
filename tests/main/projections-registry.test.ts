/**
 * The projections registry (PRINCIPLES §2, ADR 1008).
 *
 * The behavioural oracle for this refactor is the end-to-end suite
 * (`foundation-chain-push.test.ts` drives a REAL store through a built
 * Foundation and asserts the chain projection ticks during a simulated walk).
 * What this suite pins is the STRUCTURE that made it one mechanism instead of
 * five: exactly one `onMutation` subscription, one trailing throttle, and all
 * three projections coming off it.
 */

import type { PushMethod } from '@/ipc/contract';
import { PROJECTIONS, type ProjectionSource, Projections } from '@/main/modules/projections';
import type { ChainTargetView, EpoStatus, PruneStatus } from '@/types';

const STATUS = { state: 'idle', queued: 3 } as unknown as EpoStatus;
const PRUNE = { state: 'idle', candidates: 9 } as unknown as PruneStatus;
const CHAIN: ChainTargetView[] = [{ accountPk: '7' } as unknown as ChainTargetView];

function fakeStore() {
  const listeners: (() => void)[] = [];
  let unsubs = 0;
  return {
    subscriptions: () => listeners.length,
    unsubs: () => unsubs,
    fire: () => {
      for (const l of listeners) l();
    },
    onMutation(listener: () => void): () => void {
      listeners.push(listener);
      return () => {
        unsubs += 1;
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
  };
}

const source: ProjectionSource = {
  status: () => STATUS,
  pruneStatus: () => PRUNE,
  chainList: () => CHAIN,
};

test('the table names every store-derived push channel exactly once', () => {
  const channels = PROJECTIONS.map((p) => p.channel);
  expect(channels).toEqual(['status', 'pruneStatus', 'chainList']);
  expect(new Set(channels).size).toBe(channels.length);
  // `log` and `updateStatus` derive from nothing in the graph, so they must NOT
  // ride a store-mutation push.
  expect(channels).not.toContain('log' as PushMethod);
  expect(channels).not.toContain('updateStatus' as PushMethod);
});

test('one subscription pushes all three projections, coalesced on a trailing edge', async () => {
  const pushed: [PushMethod, unknown][] = [];
  const store = fakeStore();
  const projections = new Projections({
    push: (channel, payload) => pushed.push([channel, payload]),
    throttleMs: 20,
  });

  projections.bind(store, source);
  // Exactly one subscription for all three projections — the whole point.
  expect(store.subscriptions()).toBe(1);
  // The opening push: the renderer must not wait for a first mutation.
  expect(pushed.map(([c]) => c)).toEqual(['status', 'pruneStatus', 'chainList']);
  pushed.length = 0;

  // A burst of writes coalesces into ONE round of three pushes.
  store.fire();
  store.fire();
  store.fire();
  expect(pushed).toEqual([]); // trailing, never leading
  await new Promise((r) => setTimeout(r, 40));
  expect(pushed).toEqual([
    ['status', STATUS],
    ['pruneStatus', PRUNE],
    ['chainList', CHAIN],
  ]);

  projections.dispose();
});

test('unbind drops the subscription and any armed timer before the store closes', async () => {
  const pushed: PushMethod[] = [];
  const store = fakeStore();
  const projections = new Projections({ push: (channel) => pushed.push(channel), throttleMs: 20 });
  projections.bind(store, source);
  pushed.length = 0;

  store.fire(); // arms the throttle
  projections.unbind();
  expect(store.subscriptions()).toBe(0);
  expect(store.unsubs()).toBe(1);
  await new Promise((r) => setTimeout(r, 40));
  expect(pushed).toEqual([]);

  // `send` still works after unbind: the not-built status pushed on a
  // connectivity change has no graph behind it and must still reach the UI.
  projections.send('status', STATUS);
  expect(pushed).toEqual(['status']);

  // dispose() is terminal — nothing more goes out.
  projections.dispose();
  projections.send('status', STATUS);
  expect(pushed).toEqual(['status']);
});

test('rebinding to a second graph leaves exactly one live subscription', async () => {
  const pushed: PushMethod[] = [];
  const first = fakeStore();
  const second = fakeStore();
  const projections = new Projections({ push: (channel) => pushed.push(channel), throttleMs: 10 });

  projections.bind(first, source);
  projections.unbind();
  projections.bind(second, source);
  pushed.length = 0;

  first.fire(); // the torn-down graph must be silent
  await new Promise((r) => setTimeout(r, 25));
  expect(pushed).toEqual([]);

  second.fire();
  await new Promise((r) => setTimeout(r, 25));
  expect(pushed).toEqual(['status', 'pruneStatus', 'chainList']);
  projections.dispose();
});
