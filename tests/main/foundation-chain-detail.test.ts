/**
 * §2 live mirror — the Targets console's detail surface ticks DURING a pure
 * acquisition walk.
 *
 * The renderer's `useTargetDetail` re-invokes `chain:detail` every time a
 * `chainList` push arrives; that push rides the throttled store-mutation
 * subscription, so the push IS the mutation tick. This exercises the REAL
 * wiring end to end: a built Foundation, its real SQLite-backed store, and
 * per-row writes shaped like a walk's `ingestRow` (accounts + edges only — no
 * engine, no status counter moves). Each mutation burst must (a) fire the
 * chain-list push the hook keys on, and (b) leave `chainDetail` returning the
 * FRESH funnel/scanned numbers at that moment.
 */

import { POLL } from '@/timing/config';
import type { ChainTargetView } from '@/types';
import { builtFoundation, cleanupMainHarness, foundationStore } from '../kit/main-harness';

afterAll(cleanupMainHarness);

const settle = () => new Promise((r) => setTimeout(r, POLL.GRAPH_PUSH_THROTTLE_MS + 250));

test('chain:detail reflects each mutation burst of a simulated walk, tick by tick', async () => {
  const pushes: ChainTargetView[][] = [];
  const { foundation: f } = await builtFoundation({ onChainList: (list) => pushes.push(list) });
  const store = foundationStore(f);
  const now = Date.now();

  // Walk start: the chain target lands, then its first crowd row streams in.
  store.addTarget({ accountPk: '777', source: 'seed', status: 'active', chainIndex: 0 });
  store.observe({ accountPk: '777', observedAt: now, source: 'profile', fields: { username: 'hub' } });
  store.observe({
    accountPk: '888',
    observedAt: now,
    source: 'followers-list',
    fields: { username: 'crowd1' },
  });
  store.observeEdge('888', '777', 'follows', true, now);
  await settle();

  // The push (the hook's re-fetch trigger) fired for this burst…
  const pushesAfterFirstRow = pushes.length;
  expect(pushesAfterFirstRow).toBeGreaterThan(0);
  // …and the detail read at this moment carries the fresh walk knowledge.
  const first = await f.chainDetail('777');
  expect(first).toMatchObject({
    accountPk: '777',
    username: 'hub',
    scanned: 1,
    remainingActionable: 1, // the one scanned candidate is scoreable
  });
  expect(first?.trueFollowers).toBeNull(); // not enriched — never the scanned count
  expect(first?.funnel.queued).toBe(0);

  // Mid-walk: another crowd row streams in, and the Scanner queues the first
  // candidate — accounts/edges/records only, still no engine and no counters.
  store.observe({
    accountPk: '999',
    observedAt: now,
    source: 'followers-list',
    fields: { username: 'crowd2' },
  });
  store.observeEdge('999', '777', 'follows', true, now);
  store.upsertFollowRecord({
    accountPk: '888',
    targetPk: '777',
    state: 'queued',
    retryCount: 0,
  });
  await settle();

  // A fresh push fired for the second burst — the tick the hook re-fetches on…
  expect(pushes.length).toBeGreaterThan(pushesAfterFirstRow);
  // …and the SAME invoke now returns moved numbers: the surface is live.
  const second = await f.chainDetail('777');
  expect(second?.scanned).toBe(2);
  expect(second?.funnel.queued).toBe(1);
  expect(second?.remainingActionable).toBe(2); // 1 queued record + 1 scoreable candidate

  // Enrichment lands the true audience size mid-walk: the degrade lifts.
  store.observe({
    accountPk: '777',
    observedAt: now,
    source: 'profile',
    fields: { username: 'hub', followers: 40_200 },
  });
  await settle();
  expect((await f.chainDetail('777'))?.trueFollowers).toBe(40_200);

  // A pk that is not a chain target reads null, never a fabricated detail.
  expect(await f.chainDetail('888')).toBeNull();

  await f.dispose();
});
