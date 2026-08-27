import {
  GraphLayout,
  NodeGrid,
  NODE_SPACING,
  NODE_R_MAX,
  NODE_R_MIN,
  nodeRadius,
  slotOffset,
} from '@/renderer/graph/layout';
import type { GraphHub, GraphSnapshot } from '@/types';

/**
 * The Graph view's deterministic layout engine. Pure math — no canvas, no
 * preact — so the perf-critical invariants (slot stability across live
 * refreshes, non-overlapping packing, O(1) picking) are asserted directly.
 */

function hub(pk: string, kind: 'self' | 'target' = 'target'): GraphHub {
  return { pk, username: pk, kind, targetStatus: kind === 'self' ? null : 'active', chainIndex: null, memberCount: 0 };
}

/** Minimal snapshot: nodes as [pk, hubIndex, followers] triples. */
function snap(hubs: GraphHub[], nodes: Array<[string, number, number]>): GraphSnapshot {
  return {
    at: 0,
    hubs,
    pks: nodes.map((n) => n[0]),
    usernames: nodes.map((n) => n[0]),
    statuses: new Uint8Array(nodes.length),
    progress: new Float32Array(nodes.length).fill(-1),
    hubIndex: Int32Array.from(nodes.map((n) => n[1])),
    followers: Float64Array.from(nodes.map((n) => n[2])),
    counts: { known: nodes.length, queued: 0, waiting: 0, held: 0, unfollow_queued: 0, unfollowed: 0, abandoned: 0, external: 0, follows_you: 0, you_follow: 0, mutual: 0 },
  };
}

test('nodes keep their slots across refreshes; newcomers land at the rim', () => {
  const engine = new GraphLayout();
  const hubs = [hub('me', 'self'), hub('T1')];
  const a = engine.apply(snap(hubs, [['n1', 1, 0], ['n2', 1, 0], ['n3', 1, 0]]));
  // Refresh: n2 gone, n4 and n5 new. The cluster's CENTER may drift as the
  // packing absorbs growth, but n1/n3 must keep their spots inside it.
  const b = engine.apply(snap(hubs, [['n1', 1, 0], ['n3', 1, 0], ['n4', 1, 0], ['n5', 1, 0]]));
  const rel = (l: typeof a, i: number): { x: number; y: number } => {
    const c = l.clusters[1] as { x: number; y: number };
    return { x: (l.x[i] as number) - c.x, y: (l.y[i] as number) - c.y };
  };
  expect(rel(b, 0).x).toBeCloseTo(rel(a, 0).x); // n1
  expect(rel(b, 0).y).toBeCloseTo(rel(a, 0).y);
  expect(rel(b, 1).x).toBeCloseTo(rel(a, 2).x); // n3 (index shifted, slot kept)
  expect(rel(b, 1).y).toBeCloseTo(rel(a, 2).y);
  // n4 takes a FRESH slot beyond n2's retired one — further out than slot 0.
  const c1 = b.clusters[1];
  expect(c1?.members.length).toBe(4);
  const dN4 = Math.hypot(rel(b, 2).x, rel(b, 2).y);
  const dN1 = Math.hypot(rel(b, 0).x, rel(b, 0).y);
  expect(dN4).toBeGreaterThan(dN1);
});

test('phyllotaxis keeps neighbors at least ~a slot spacing apart', () => {
  const pts = Array.from({ length: 400 }, (_, slot) => slotOffset(slot));
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i] as { x: number; y: number };
      const b = pts[j] as { x: number; y: number };
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  // Comfortably above two max node radii — dots can never overlap.
  expect(min).toBeGreaterThan(NODE_R_MAX * 2);
  expect(min).toBeGreaterThan(NODE_SPACING * 0.7);
});

test('cluster circles never overlap, whatever the size mix', () => {
  const engine = new GraphLayout();
  const hubs = [hub('me', 'self'), hub('T1'), hub('T2'), hub('T3'), hub('T4')];
  const nodes: Array<[string, number, number]> = [];
  const sizes = [40, 800, 3, 250, 90];
  sizes.forEach((count, hubIdx) => {
    for (let i = 0; i < count; i++) nodes.push([`h${hubIdx}-${i}`, hubIdx, 0]);
  });
  const layout = engine.apply(snap(hubs, nodes));
  for (let i = 0; i < layout.clusters.length; i++) {
    for (let j = i + 1; j < layout.clusters.length; j++) {
      const a = layout.clusters[i] as { x: number; y: number; r: number };
      const b = layout.clusters[j] as { x: number; y: number; r: number };
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
    }
  }
  // Bounds cover every cluster circle.
  for (const c of layout.clusters) {
    expect(c.x - c.r).toBeGreaterThanOrEqual(layout.bounds.minX - 1e-6);
    expect(c.x + c.r).toBeLessThanOrEqual(layout.bounds.maxX + 1e-6);
    expect(c.y - c.r).toBeGreaterThanOrEqual(layout.bounds.minY - 1e-6);
    expect(c.y + c.r).toBeLessThanOrEqual(layout.bounds.maxY + 1e-6);
  }
});

test('node radius scales with followers on a log curve, bounded both ends', () => {
  expect(nodeRadius(-1)).toBe(NODE_R_MIN);
  expect(nodeRadius(0)).toBeCloseTo(NODE_R_MIN);
  expect(nodeRadius(100)).toBeGreaterThan(nodeRadius(10));
  expect(nodeRadius(10_000_000)).toBe(NODE_R_MAX);
});

test('the spatial grid picks the node under the point, and misses cleanly', () => {
  const engine = new GraphLayout();
  const layout = engine.apply(
    snap([hub('me', 'self')], [['n1', 0, 0], ['n2', 0, 0], ['n3', 0, 0]]),
  );
  const grid = new NodeGrid(layout.x, layout.y, layout.r);
  for (let i = 0; i < 3; i++) {
    expect(grid.pick(layout.x[i] as number, layout.y[i] as number)).toBe(i);
  }
  expect(grid.pick(1e6, 1e6)).toBe(-1);
});
