import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * §2 live mirror — the chain projection rides the mutation-driven push.
 *
 * During a pure acquisition walk, observations write accounts/edges only: no
 * EngineStatus counter moves, so a renderer that re-pulled `chain:list` on
 * status-counter changes would stay frozen exactly while the walk runs (the
 * "Followed under Now Targeting never ticks" bug). The fix routes the chain
 * projection through the SAME throttled store-mutation push as the two status
 * projections. This exercises the REAL wiring: a built Foundation, its real
 * SQLite-backed store, and per-row writes shaped like a walk's `ingestRow` —
 * the `onChainList` callback must fire with the fresh projection, no engine
 * activity involved.
 *
 * Electron is mocked at module scope exactly as in foundation-teardown.test.ts:
 * `app.getPath` → a temp dir, and the IG partition serves a fixed `ds_user_id`.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-chain-push-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmp },
  session: {
    fromPartition: () => ({
      cookies: { get: async () => [{ name: 'ds_user_id', value: '4242' }] },
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  },
}));

import type { InstagramTab } from '@/adapter/tab';
import { Foundation } from '@/main/foundation-wiring';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { POLL } from '@/timing/config';
import type { ChainTargetView } from '@/types';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fakeTab = {
  show: () => {},
  hide: () => {},
  goto: async () => {},
  currentUrl: () => 'https://www.instagram.com/',
  evaluate: async () => '/myself/',
  onResponse: () => () => {},
} as unknown as InstagramTab;

test('a follower-edge write during a simulated walk pushes a fresh chain projection', async () => {
  const pushes: ChainTargetView[][] = [];
  const f = new Foundation({ tab: fakeTab, onChainList: (list) => pushes.push(list) });

  expect(await f.ensureBuilt()).toBe(true);
  // The build itself pushes the (empty) projection so the renderer never waits
  // for a first mutation.
  expect(pushes.length).toBeGreaterThanOrEqual(1);
  expect(pushes[pushes.length - 1]).toEqual([]);
  const pushesAfterBuild = pushes.length;

  // Reach the REAL store the Foundation built (the same one its onMutation →
  // scheduleGraphPush subscription watches) and write exactly what a walk's
  // per-row ingest writes: the chain target, then a crowd profile observation
  // plus its follows-edge into the target. No engine runs; no status counter
  // moves — this is the §2 case a counter-keyed refetch alone cannot cover.
  const store = (f as unknown as { graph: { store: KnowledgeStore } }).graph.store;
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
