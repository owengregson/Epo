/**
 * `GraphWorld` — the Graph stage's imperative canvas world.
 *
 * This suite deliberately runs in the NODE environment (no jsdom docblock):
 * the world must stay DOM- and Preact-free, so importing it here is itself a
 * standing assertion. The frame is exercised through a hand-written 2D-context
 * stub, which lets the level-of-detail and animation contracts be asserted on
 * what the canvas would actually paint rather than on a screenshot.
 */
import { NODE_SPACING } from '@/renderer/graph/layout';
import {
  AGGREGATE_BELOW_PX,
  BLOOM_SPREAD_MS,
  ENTER_MS,
  GraphWorld,
  ZOOM_MAX,
  ZOOM_OUT_SLACK,
} from '@/renderer/graph/world';
import type { GraphHub, GraphSnapshot } from '@/types';

const VW = 900;
const VH = 700;

/** Minimal 2D context: every call the world makes, recorded. */
function stubCtx() {
  const fns = {
    setTransform: jest.fn(),
    clearRect: jest.fn(),
    beginPath: jest.fn(),
    arc: jest.fn(),
    rect: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    fill: jest.fn(),
    stroke: jest.fn(),
    fillText: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    closePath: jest.fn(),
  };
  const ctx = {
    ...fns,
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, ...fns };
}

function hub(pk: string, kind: 'self' | 'target' = 'target'): GraphHub {
  return {
    pk,
    username: pk,
    kind,
    targetStatus: kind === 'self' ? null : 'active',
    chainIndex: null,
    memberCount: 0,
  };
}

const NO_COUNTS: GraphSnapshot['counts'] = {
  known: 0,
  queued: 0,
  waiting: 0,
  held: 0,
  unfollow_queued: 0,
  unfollowed: 0,
  abandoned: 0,
  external: 0,
  follows_you: 0,
  you_follow: 0,
  mutual: 0,
};

/** A node fixture: [pk, hub index, status index]. */
type Node = [string, number, number];

function snap(hubs: GraphHub[], nodes: Node[]): GraphSnapshot {
  return {
    at: 0,
    hubs,
    pks: nodes.map((n) => n[0]),
    usernames: nodes.map((n) => n[0]),
    statuses: Uint8Array.from(nodes.map((n) => n[2])),
    progress: new Float32Array(nodes.length).fill(-1),
    hubIndex: Int32Array.from(nodes.map((n) => n[1])),
    followers: new Float64Array(nodes.length).fill(-1),
    counts: { ...NO_COUNTS, known: nodes.length },
  };
}

/** `count` plain `known` nodes on `hubIdx`, named `<prefix>0…`. */
function nodes(count: number, hubIdx = 0, prefix = 'n'): Node[] {
  return Array.from({ length: count }, (_, i): Node => [`${prefix}${i}`, hubIdx, 0]);
}

/** The same nodes with one member's status moved — a lifecycle transition. */
function withStatus(list: Node[], index: number, statusIdx: number): Node[] {
  return list.map((n, i): Node => (i === index ? [n[0], n[1], statusIdx] : n));
}

function worldWith(hubs: GraphHub[], list: Node[], reduced = true, now = 0): GraphWorld {
  const world = new GraphWorld();
  world.setViewport(VW, VH, 1);
  world.setSnapshot(snap(hubs, list), { reduced, now });
  return world;
}

// --- Camera ----------------------------------------------------------------

test('zoomAt clamps at ZOOM_MAX above and fit-scale × slack below', () => {
  const world = worldWith([hub('me', 'self')], nodes(200));
  expect(world.fit(false)).toBe(true);
  const { fitScale } = world;
  expect(fitScale).toBeGreaterThan(0);

  for (let i = 0; i < 40; i++) {
    world.zoomAt(3, VW / 2, VH / 2, false);
    expect(world.cam.scale).toBeLessThanOrEqual(ZOOM_MAX);
  }
  expect(world.cam.scale).toBe(ZOOM_MAX); // it does reach the ceiling

  const floor = fitScale * ZOOM_OUT_SLACK;
  for (let i = 0; i < 60; i++) {
    world.zoomAt(0.3, VW / 2, VH / 2, false);
    expect(world.cam.scale).toBeGreaterThanOrEqual(floor);
  }
  expect(world.cam.scale).toBeCloseTo(floor, 10); // and it does reach the floor
});

test('reduced motion snaps the camera; otherwise it eases', () => {
  const hubs = [hub('me', 'self'), hub('t1')];
  const members = [...nodes(20, 0), ...nodes(20, 1, 'm')];

  const calm = worldWith(hubs, members, true);
  calm.fit(false);
  expect(calm.fitCluster(1)).toBe(true);
  expect(calm.camAnim).toBeNull(); // landed at once — no glide to run
  expect(calm.cam.x).toBeCloseTo(calm.layout?.clusters[1]?.x as number, 6);

  const live = worldWith(hubs, members, false);
  live.fit(false);
  expect(live.fitCluster(1)).toBe(true);
  expect(live.camAnim).not.toBeNull();
});

// --- Level of detail --------------------------------------------------------

test('under the aggregate threshold a cluster is ONE disc; above it, one arc per node', () => {
  const MEMBERS = 60;
  const world = worldWith([hub('me', 'self')], nodes(MEMBERS));
  world.fit(false);
  expect(NODE_SPACING * world.cam.scale).toBeGreaterThan(AGGREGATE_BELOW_PX);

  const near = stubCtx();
  expect(world.draw(near.ctx)).toBe(false); // nothing animating: no re-arm
  expect(near.arc.mock.calls.length).toBeGreaterThanOrEqual(MEMBERS);

  // Zoom out until the on-screen slot spacing falls under the threshold.
  world.cam.scale = (AGGREGATE_BELOW_PX / NODE_SPACING) * 0.5;
  const far = stubCtx();
  world.draw(far.ctx);
  // The aggregate disc plus the hub core — two arcs for sixty accounts.
  expect(far.arc).toHaveBeenCalledTimes(2);
  expect(far.arc.mock.calls.length).toBeLessThan(MEMBERS);
});

// --- Picking ----------------------------------------------------------------

test('pick hits a node, hits a hub core, and returns null over empty space', () => {
  const world = worldWith([hub('me', 'self')], nodes(40));
  world.fit(false);
  const layout = world.layout;
  if (layout === null) throw new Error('expected a layout');
  const toScreen = (wx: number, wy: number): { sx: number; sy: number } => ({
    sx: (wx - world.cam.x) * world.cam.scale + VW / 2,
    sy: (wy - world.cam.y) * world.cam.scale + VH / 2,
  });

  const onNode = toScreen(layout.x[7] as number, layout.y[7] as number);
  expect(world.pick(onNode.sx, onNode.sy)).toEqual({ kind: 'node', index: 7 });

  const core = layout.clusters[0] as { x: number; y: number };
  // The innermost spiral slot sits a full HUB_R clear of the core, so the
  // core's own disc wins the hit-test rather than a member's.
  const onHub = toScreen(core.x, core.y);
  expect(world.pick(onHub.sx, onHub.sy)).toEqual({ kind: 'hub', index: 0 });

  const nowhere = toScreen(layout.bounds.maxX + 4000, layout.bounds.maxY + 4000);
  expect(world.pick(nowhere.sx, nowhere.sy)).toBeNull();
});

// --- Entrances (bloom) ------------------------------------------------------

test('the first snapshot blooms outward from the hub, capped at BLOOM_SPREAD_MS', () => {
  const NOW = 1_000;
  // Enough members that the outermost spiral slots run past the cap.
  const world = worldWith([hub('me', 'self')], nodes(1600), false, NOW);

  expect(world.born.size).toBe(1600);
  const delays = Array.from(world.born.values(), (at) => at - NOW);
  expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...delays)).toBe(BLOOM_SPREAD_MS); // capped, never longer
  const delayOf = (pk: string): number => (world.born.get(pk) as number) - NOW;
  expect(delayOf('n400')).toBeGreaterThan(delayOf('n4')); // farther out = later
  expect(delayOf('n0')).toBeLessThan(BLOOM_SPREAD_MS / 10); // the innermost barely waits
  expect(world.enterUntil).toBe(NOW + BLOOM_SPREAD_MS + ENTER_MS);
});

test('a later snapshot registers entrances only for pks the previous one lacked', () => {
  const hubs = [hub('me', 'self')];
  const world = worldWith(hubs, nodes(30), false, 1_000);
  expect(world.born.size).toBe(30);

  const later = 1_000 + BLOOM_SPREAD_MS + ENTER_MS + 1; // every bloom has finished
  world.setSnapshot(snap(hubs, [...nodes(30), ['fresh', 0, 0]]), { reduced: false, now: later });
  expect([...world.born.keys()]).toEqual(['fresh']);
  expect(world.born.get('fresh')).toBe(later); // newcomers pop in place, unstaggered
});

test('reduced motion registers no entrances and no status-change rings', () => {
  const hubs = [hub('me', 'self')];
  const calm = worldWith(hubs, nodes(20), true, 0);
  expect(calm.born.size).toBe(0);
  expect(calm.animUntil).toBe(0); // nothing to run, so the rAF loop never starts
  calm.setSnapshot(snap(hubs, withStatus(nodes(20), 3, 2)), { reduced: true, now: 500 });
  expect(calm.born.size).toBe(0);
  expect(calm.flash.size).toBe(0);

  // The same transition DOES fire a ring when motion is allowed.
  const live = worldWith(hubs, nodes(20), false, 0);
  live.setSnapshot(snap(hubs, withStatus(nodes(20), 3, 2)), { reduced: false, now: 900 });
  expect([...live.flash.keys()]).toEqual(['n3']);
});
