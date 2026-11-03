/**
 * The plan's triggers in the composed app (spec §5.6): the graph build writes the plan, a completed
 * census re-plans the demand, a system resume re-reads the plan, a Boost holds a manual prune, and
 * the teardown withdraws the preview port.
 */
import type { Foundation } from '@/main/foundation-wiring';
import type { BuiltGraph } from '@/main/services/graph-builder';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

afterAll(cleanupMainHarness);

const internal = (f: Foundation) => f as unknown as {
  session: { current(): BuiltGraph | null };
  settings: { planPort(): unknown };
};
const graphOf = (f: Foundation): BuiltGraph => {
  const g = internal(f).session.current();
  if (g === null) throw new Error('no graph');
  return g;
};

test('the build writes the plan and registers the preview port; the teardown withdraws it', async () => {
  const { foundation } = newFoundation();
  expect(await foundation.ensureBuilt()).toBe(true);
  const graph = graphOf(foundation);
  expect(graph.store.getPlanState()).not.toBeNull();
  expect(internal(foundation).settings.planPort()).toBe(graph.plan.service);
  expect((await foundation.status()).plan?.day.key).toBe(graph.plan.service.view().window.key);
  await foundation.dispose();
  expect(internal(foundation).settings.planPort()).toBeNull();
});

test('a completed census re-plans the demand; a system resume re-reads the plan', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  const graph = graphOf(foundation);
  jest.spyOn(graph.pruneEngine, 'scan').mockResolvedValue({ following: 0, followers: 0, candidates: [], aborted: false });
  expect((await foundation.scanPrune()).ok).toBe(true);
  expect(JSON.parse(graph.store.getPlanState() ?? '{}').plan.cause).toBe('demand');
  const resumed = jest.spyOn(graph.plan, 'resumed');
  await foundation.resumeFromSleep({ settleMsOverride: 0 });
  expect(resumed).toHaveBeenCalledTimes(1);
  await foundation.dispose();
});

test('a manual prune waits while a Boost window is open', async () => {
  const { foundation } = newFoundation();
  await foundation.ensureBuilt();
  graphOf(foundation).plan.service.startBoost(3_600_000);
  expect(await foundation.scanPrune()).toMatchObject({ ok: false, reason: 'boost-active' });
  await foundation.dispose();
});
