/**
 * §2 live mirror — the chain projection rides the mutation-driven push.
 *
 * During a pure acquisition walk, observations write accounts/edges only: no
 * EngineStatus counter moves, so a renderer that re-pulled `chain:list` on
 * status-counter changes would stay frozen exactly while the walk runs. The
 * chain projection therefore routes through the SAME throttled store-mutation
 * push as the two status projections. This exercises the REAL wiring: a built
 * Foundation, its real SQLite-backed store, and per-row writes shaped like a
 * walk's `ingestRow` — the `onChainList` callback must fire with the fresh
 * projection, no engine activity involved.
 */

import { POLL } from '@/timing/config';
import type { ChainTargetView } from '@/types';
import { builtFoundation, cleanupMainHarness, foundationStore } from '../kit/main-harness';

afterAll(cleanupMainHarness);

test('a follower-edge write during a simulated walk pushes a fresh chain projection', async () => {
  const pushes: ChainTargetView[][] = [];
  const { foundation: f } = await builtFoundation({ onChainList: (list) => pushes.push(list) });

  // The build itself pushes the (empty) projection so the renderer never waits
  // for a first mutation.
  expect(pushes.length).toBeGreaterThanOrEqual(1);
  expect(pushes[pushes.length - 1]).toEqual([]);
  const pushesAfterBuild = pushes.length;

  // Write exactly what a walk's per-row ingest writes into the REAL store the
  // Foundation built: the chain target, then a crowd profile observation plus
  // its follows-edge into the target. No engine runs; no status counter moves —
  // this is the §2 case a counter-keyed refetch alone cannot cover.
  const store = foundationStore(f);
  const now = Date.now();
  store.addTarget({ accountPk: '777', source: 'seed', status: 'active', chainIndex: 0 });
  store.observe({ accountPk: '777', observedAt: now, source: 'profile', fields: { username: 'hub' } });
  store.observe({
    accountPk: '888',
    observedAt: now,
    source: 'followers-list',
    fields: { username: 'crowd1' },
  });
  store.observeEdge('888', '777', 'follows', true, now);

  // The push is trailing-throttled off the mutation burst — wait it out.
  await new Promise((r) => setTimeout(r, POLL.GRAPH_PUSH_THROTTLE_MS + 250));

  expect(pushes.length).toBeGreaterThan(pushesAfterBuild);
  const last = pushes[pushes.length - 1] as ChainTargetView[];
  expect(last).toHaveLength(1);
  expect(last[0]).toMatchObject({
    accountPk: '777',
    username: 'hub',
    yield: expect.objectContaining({ poolSize: 1, total: 0 }),
  });

  await f.dispose();
});
