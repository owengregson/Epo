/**
 * Where each definition's record or page sits — capture 2026-08-12 (spec §10.3). The canonical
 * container comes first; a newly observed wrapper is one more line here, with its evidence.
 */

import type { ContainerDecl } from '@/surface/schema/decls';
import { JSON_PATHS } from '@/surface/versions/2026-08-12/literals';

type Containers = readonly [ContainerDecl, ...ContainerDecl[]];

const root = (evidence: string): Containers => [{ at: '', kind: 'object', evidence }];
const CONNECTION = JSON_PATHS.followRequestsConnection;

export const CONTAINERS = {
  friendshipShow: root('2026-08-12 capture: 1/1'),
  showMany: root('2026-08-12 capture: 1/1'),
  list: root('2026-08-12 capture: 4/4 followers pages; the following list shares the shape'),
  profileInfo: [{ at: JSON_PATHS.profileUserAt.info, kind: 'object', absentWhenNull: true,
    evidence: 'retired 2026-10-08; no corpus body' }],
  profileGraphql: [{ at: JSON_PATHS.profileUserAt.graphql, kind: 'object', absentWhenNull: true,
    evidence: '2026-11-02 verify: 3/3' }],
  feedRest: root('the REST inbox until 2026-10; no corpus body'),
  feedGraphql: [{ at: JSON_PATHS.activityFeedGraphql, kind: 'object', evidence: '2026-11-02 verify: 2/2' }],
  requestsRest: root('2026-08-12 capture: 1/1'),
  requestsGraphql: [{
    at: CONNECTION.at, kind: 'connection',
    connection: { edges: CONNECTION.edges, node: CONNECTION.node, cursor: CONNECTION.cursor, hasNext: CONNECTION.hasNext },
    evidence: '2026-11-02 verify: 1/1',
  }],
} as const satisfies Record<string, Containers>;
