/**
 * Status composition (spec §15.3, §14 C22): `basis` is graph-independent, the
 * current graph's contributors apply in order, extra contributors last; every
 * wiring module returns its own (empty in Phase F) startup steps and contributors.
 */

import { notBuiltStatus } from '@/main/modules/not-built';
import { type BaseStatus, composeStatus, type StatusContributor } from '@/main/modules/status-compose';
import type { BuiltGraph } from '@/main/services/graph-types';
import { reopenWiringParts } from '@/main/services/reopen-wiring';
import { surfaceWiringParts } from '@/main/services/surface-wiring';
import { unfollowWiringParts } from '@/main/services/unfollow-wiring';
import { NOT_BUILT_FIELDS } from '@/shared/status-fields';
import { idleStatus } from '../kit/render-bridge';

const { basis: _basis, ...engine } = idleStatus();
const base: BaseStatus = engine;
const graphWith = (statusContributors: StatusContributor[]): BuiltGraph =>
  ({ statusContributors, startupSteps: [] }) as unknown as BuiltGraph;

test('a status composed without a graph is not-built; over a graph it is built', () => {
  expect(composeStatus(base, [], null, 0).basis).toBe('not-built');
  expect(composeStatus(base, [], graphWith([]), 0).basis).toBe('built');
});

test("the graph's contributors apply in order, then the extra ones, each seeing graph and now", () => {
  const seen: Array<[string, number]> = [];
  const contributor = (name: string, fields: Partial<BaseStatus>): StatusContributor => ({
    name,
    contribute: (graph, now) => {
      seen.push([name, now]);
      expect(graph).not.toBeNull();
      return fields;
    },
  });
  const graph = graphWith([
    contributor('boost', { boost: null }),
    contributor('requests', { requests: { count: 2, complete: true, observedAt: 5 } }),
  ]);
  const extra = contributor('requests-late', { requests: { count: 3, complete: false, observedAt: 6 } });
  const status = composeStatus(base, [extra], graph, 42);
  expect(seen).toEqual([['boost', 42], ['requests', 42], ['requests-late', 42]]);
  expect(status.requests).toEqual({ count: 3, complete: false, observedAt: 6 });
  expect(status.boost).toBeNull();
  expect(status.basis).toBe('built');
});

test('the not-built status sets basis and nulls every optional status field', () => {
  const s = notBuiltStatus(false, true);
  expect(s).toMatchObject(NOT_BUILT_FIELDS);
  expect(Object.values(NOT_BUILT_FIELDS).filter((v) => v !== null)).toEqual(['not-built']);
});

test('every wiring module returns its startup steps and status contributors (none yet but the surface, plan and unfollow ones)', () => {
  for (const parts of [reopenWiringParts()]) {
    expect(parts).toEqual({ startupSteps: [], statusContributors: [] });
  }
  const surface = surfaceWiringParts();
  expect(surface.startupSteps).toEqual([]);
  expect(surface.statusContributors.map((c) => c.name)).toEqual(['surface']);
  expect(surface.statusContributors[0]?.contribute(null, 0)).toEqual({ surface: null });
  // The unfollow wiring returns its one contributor (tests/main/unfollow-wiring.test.ts).
  expect(unfollowWiringParts().statusContributors.map((c) => c.name)).toEqual(['unfollowsPaused']);
});
