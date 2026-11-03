/**
 * Every day-keyed consumer of a built graph counts on the plan's one boundary (spec §4.4; workplan §I.1 after
 * merge #18): the build hands the plan's day clock to the unfollow wiring (protection, the policy's and the
 * journal's park slots, churn and its reconciler, the prune's protection), the follow-back watcher, the
 * surface wiring and the live sources; the seed check reads the open graph's clock. The calendar clock
 * survives only as a default no production path takes. The resume target peeks through the engine's frontier.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createEngine } from '@/engine/engine';
import type { Foundation } from '@/main/foundation-wiring';
import type { BuiltGraph } from '@/main/services/graph-builder';
import { liveSources, liveWiringParts } from '@/main/services/live-wiring';
import { wireFollowback } from '@/main/services/reopen-wiring';
import { wireSurface } from '@/main/services/surface-wiring';
import { journalSettler, pruneUnfollowDeps, wireChurn, wireMutationPolicy } from '@/main/services/unfollow-wiring';
import { cleanupMainHarness, newFoundation } from '../kit/main-harness';

jest.mock('@/main/services/unfollow-wiring', () => {
  const actual = jest.requireActual<typeof import('@/main/services/unfollow-wiring')>('@/main/services/unfollow-wiring');
  return { ...actual, wireMutationPolicy: jest.fn(actual.wireMutationPolicy), journalSettler: jest.fn(actual.journalSettler),
    wireChurn: jest.fn(actual.wireChurn), pruneUnfollowDeps: jest.fn(actual.pruneUnfollowDeps) };
});
jest.mock('@/main/services/reopen-wiring', () => {
  const actual = jest.requireActual<typeof import('@/main/services/reopen-wiring')>('@/main/services/reopen-wiring');
  return { ...actual, wireFollowback: jest.fn(actual.wireFollowback) };
});
jest.mock('@/main/services/surface-wiring', () => {
  const actual = jest.requireActual<typeof import('@/main/services/surface-wiring')>('@/main/services/surface-wiring');
  return { ...actual, wireSurface: jest.fn(actual.wireSurface) };
});
jest.mock('@/main/services/live-wiring', () => {
  const actual = jest.requireActual<typeof import('@/main/services/live-wiring')>('@/main/services/live-wiring');
  return { ...actual, liveSources: jest.fn(actual.liveSources), liveWiringParts: jest.fn(actual.liveWiringParts) };
});
jest.mock('@/engine/engine', () => {
  const actual = jest.requireActual<typeof import('@/engine/engine')>('@/engine/engine');
  return { ...actual, createEngine: jest.fn(actual.createEngine) };
});

const open: Foundation[] = [];
const graphOf = (f: Foundation): BuiltGraph => {
  const g = (f as unknown as { session: { current(): BuiltGraph | null } }).session.current();
  if (g === null) throw new Error('no graph');
  return g;
};
const built = async (): Promise<{ foundation: Foundation; graph: BuiltGraph }> => {
  const { foundation } = newFoundation();
  open.push(foundation);
  expect(await foundation.ensureBuilt()).toBe(true);
  return { foundation, graph: graphOf(foundation) };
};
afterEach(async () => {
  while (open.length > 0) await open.pop()?.dispose();
});
afterAll(cleanupMainHarness);

/** The arguments of the build's last call to a wiring function. */
function handed<A extends unknown[]>(fn: (...args: A) => unknown): A {
  const call = jest.mocked(fn).mock.calls.at(-1);
  if (call === undefined) throw new Error(`${fn.name} was never called`);
  return call;
}

test("a built graph hands the plan's day clock to every day-keyed consumer", async () => {
  const day = (await built()).graph.plan.dayClock;
  const clocks = {
    mutationPolicy: handed(wireMutationPolicy)[1].dayClock,
    journal: handed(journalSettler)[1].dayClock,
    churn: handed(wireChurn)[1].dayClock,
    prune: handed(pruneUnfollowDeps)[1].dayClock,
    followback: handed(wireFollowback)[1].dayClock,
    surface: handed(wireSurface)[0].day,
    live: handed(liveSources)[2]?.planDay,
  };
  expect(Object.entries(clocks).filter(([, clock]) => clock !== day).map(([consumer]) => consumer)).toEqual([]);
});

test("the resume target peeks through the engine's own frontier, so the status shows the pick a start adopts", async () => {
  await built();
  const engineFrontier = handed(createEngine)[0].frontier;
  expect(engineFrontier).toBeDefined();
  expect(handed(liveWiringParts)[0]?.frontier).toBe(engineFrontier);
});

test("the seed check's freshness counts in the open graph's plan-days", async () => {
  const { foundation, graph } = await built();
  const now = Date.now();
  graph.store.observe({ accountPk: '77', observedAt: now, source: 'profile',
    fields: { username: 'friend', isPrivate: false, followers: 10, following: 5 } });
  const window = jest.spyOn(graph.plan.dayClock, 'window');
  expect(await foundation.seed.check('friend')).toMatchObject({ kind: 'ok', pk: '77', fromStore: true });
  expect(window).toHaveBeenCalled();
});

test('the calendar clock is left only as a default no production path takes', () => {
  const root = path.join(__dirname, '../../src');
  const users: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /calendarPlanDayClock\(/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(root, p));
    }
  };
  walk(root);
  expect(users.sort()).toEqual([
    'engine/churn-scheduler.ts', // parkSlots absent: the unit kits; unfollow-wiring passes the plan's slots
    'engine/protection-port.ts', // unconfiguredProtection: a rig without the settings service
    'governors/plan-day-clock.ts', // the definition
    'governors/rate-governor.ts', // no plan: the unit kits and the livetest rig; plan-wiring passes the plan's
    'main/modules/seed-check.ts', // planDay absent: the settings-facts kit; the Foundation passes the open graph's
    'main/services/live-wiring.ts', // planDay absent: no caller; the Foundation passes the graph's
    'main/services/prepare-mutation.ts', // parkSlots absent: the mutation-policy kit; unfollow-wiring passes them
    'main/services/surface-wiring.ts', // day absent: no caller; the graph build passes the plan's
  ]);
});
