/**
 * Deterministic bubble layout for the Graph view.
 *
 * No physics: every node sits on a phyllotaxis (sunflower) spiral inside its
 * hub's cluster, so laying out tens of thousands of nodes is O(n) arithmetic
 * and the same input always draws the same picture. Two stability rules keep
 * the canvas calm while the store streams during scans (docs/PRINCIPLES.md
 * §2 — the view refreshes live):
 *
 *  - SLOT PERSISTENCE: a node keeps its spiral slot across refreshes (slots
 *    are handed out per hub, first sight first slot, and never reassigned),
 *    so a refresh only ADDS dots at cluster rims instead of reshuffling.
 *  - DETERMINISTIC PACKING: cluster centers derive from hub order and radii
 *    alone; growth nudges the packing gradually rather than rearranging it.
 *
 * Pure module (no preact, no DOM beyond typed arrays) — unit-tested directly.
 */
import type { GraphSnapshot } from '@/types';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** World units between phyllotaxis slots (must exceed 2 × max node radius). */
export const NODE_SPACING = 16;
/** Node radius range in world units; follower count picks the point between. */
export const NODE_R_MIN = 3.2;
export const NODE_R_MAX = 7;
/** Hub core disc radius (world units); member spirals start outside it. */
export const HUB_R = 26;
/** Clearance kept between packed cluster circles. */
export const CLUSTER_PAD = 60;

export interface ClusterPlacement {
  /** Cluster center in world coordinates. */
  x: number;
  y: number;
  /** Bounding radius (hub core + occupied spiral). */
  r: number;
  /** Members' node indices into the snapshot's parallel arrays. */
  members: number[];
}

export interface LayoutResult {
  /** Per-node world position and radius (parallel to the snapshot arrays). */
  x: Float32Array;
  y: Float32Array;
  r: Float32Array;
  /** Per-hub placement (parallel to `snapshot.hubs`). */
  clusters: ClusterPlacement[];
  /** World-space bounds of everything drawn, for fit-to-view. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Spiral-local offset of a slot (before the cluster center is added). */
export function slotOffset(slot: number): { x: number; y: number } {
  const radius = HUB_R + NODE_SPACING * Math.sqrt(slot + 0.6);
  const angle = slot * GOLDEN_ANGLE;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** Node radius from its follower count (log scale; unknown counts stay small). */
export function nodeRadius(followerCount: number): number {
  if (followerCount < 0) return NODE_R_MIN;
  const t = Math.min(1, Math.log10(followerCount + 1) / 6); // 1M+ maxes out
  return NODE_R_MIN + (NODE_R_MAX - NODE_R_MIN) * t;
}

/** Bounding radius of a cluster whose highest handed-out slot is `maxSlot`. */
function clusterRadius(maxSlot: number): number {
  if (maxSlot < 0) return HUB_R + NODE_SPACING;
  return HUB_R + NODE_SPACING * Math.sqrt(maxSlot + 0.6) + NODE_R_MAX + NODE_SPACING * 0.5;
}

/**
 * Place cluster circles without overlap: the self hub anchors the origin and
 * each following hub walks a golden-angle spiral outward until it clears
 * everything already placed. Deterministic in (order, radii).
 */
function packClusters(radii: number[]): Array<{ x: number; y: number }> {
  const placed: Array<{ x: number; y: number; r: number }> = [];
  const centers: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < radii.length; i++) {
    const r = radii[i] as number;
    if (placed.length === 0) {
      placed.push({ x: 0, y: 0, r });
      centers.push({ x: 0, y: 0 });
      continue;
    }
    let best = { x: 0, y: 0 };
    let dist = (placed[0] as { r: number }).r + r + CLUSTER_PAD;
    let step = 0;
    for (;;) {
      const angle = (i - 1) * GOLDEN_ANGLE + step * 0.7;
      const x = Math.cos(angle) * dist;
      const y = Math.sin(angle) * dist;
      const clear = placed.every((p) => {
        const dx = x - p.x;
        const dy = y - p.y;
        return Math.hypot(dx, dy) >= p.r + r + CLUSTER_PAD * 0.5;
      });
      if (clear) {
        best = { x, y };
        break;
      }
      step += 1;
      if (step % 9 === 0) dist += Math.max(40, r * 0.35); // widen the search ring
    }
    placed.push({ x: best.x, y: best.y, r });
    centers.push(best);
  }
  return centers;
}

/**
 * Stateful layout engine: owns the per-hub slot maps that keep node positions
 * stable across live snapshot refreshes. One instance lives for as long as
 * the Graph stage is open.
 */
export class GraphLayout {
  /** hub pk → (node pk → slot). Slots are handed out once, never reused. */
  private readonly slots = new Map<string, Map<string, number>>();
  private readonly nextSlot = new Map<string, number>();

  apply(snapshot: GraphSnapshot): LayoutResult {
    const n = snapshot.pks.length;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const r = new Float32Array(n);

    // 1. Hand out (or recall) a spiral slot per node, per hub.
    const perHubMembers: number[][] = snapshot.hubs.map(() => []);
    const perHubMaxSlot: number[] = snapshot.hubs.map(() => -1);
    const nodeSlot = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const hubIdx = snapshot.hubIndex[i] as number;
      const hub = snapshot.hubs[hubIdx];
      if (!hub) continue;
      let hubSlots = this.slots.get(hub.pk);
      if (!hubSlots) {
        hubSlots = new Map();
        this.slots.set(hub.pk, hubSlots);
      }
      const pk = snapshot.pks[i] as string;
      let slot = hubSlots.get(pk);
      if (slot === undefined) {
        slot = this.nextSlot.get(hub.pk) ?? 0;
        this.nextSlot.set(hub.pk, slot + 1);
        hubSlots.set(pk, slot);
      }
      nodeSlot[i] = slot;
      (perHubMembers[hubIdx] as number[]).push(i);
      if (slot > (perHubMaxSlot[hubIdx] as number)) perHubMaxSlot[hubIdx] = slot;
    }

    // 2. Pack the cluster circles (self first — snapshot.hubs order).
    const radii = snapshot.hubs.map((hub, idx) => {
      // A hub keeps the radius its slot history implies even if members left,
      // so the packing never contracts and jumps under a live refresh.
      const handedOut = (this.nextSlot.get(hub.pk) ?? 0) - 1;
      return clusterRadius(Math.max(handedOut, perHubMaxSlot[idx] as number));
    });
    const centers = packClusters(radii);
    const clusters: ClusterPlacement[] = snapshot.hubs.map((_, idx) => ({
      x: (centers[idx] as { x: number }).x,
      y: (centers[idx] as { y: number }).y,
      r: radii[idx] as number,
      members: perHubMembers[idx] as number[],
    }));

    // 3. World positions: cluster center + spiral offset.
    for (let i = 0; i < n; i++) {
      const cluster = clusters[snapshot.hubIndex[i] as number];
      if (!cluster) continue;
      const off = slotOffset(nodeSlot[i] as number);
      x[i] = cluster.x + off.x;
      y[i] = cluster.y + off.y;
      r[i] = nodeRadius(snapshot.followers[i] as number);
    }

    // 4. Bounds over the cluster circles (covers hubs with zero members too).
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const c of clusters) {
      minX = Math.min(minX, c.x - c.r);
      minY = Math.min(minY, c.y - c.r);
      maxX = Math.max(maxX, c.x + c.r);
      maxY = Math.max(maxY, c.y + c.r);
    }
    if (clusters.length === 0) {
      minX = -1;
      minY = -1;
      maxX = 1;
      maxY = 1;
    }

    return { x, y, r, clusters, bounds: { minX, minY, maxX, maxY } };
  }
}

/** Uniform spatial hash over node positions, for O(1) hover picking. */
export class NodeGrid {
  private readonly cell: number;
  private readonly map = new Map<number, number[]>();

  constructor(
    private readonly x: Float32Array,
    private readonly y: Float32Array,
    private readonly r: Float32Array,
    cell = NODE_SPACING * 2,
  ) {
    this.cell = cell;
    for (let i = 0; i < x.length; i++) {
      const key = this.keyOf(x[i] as number, y[i] as number);
      const bucket = this.map.get(key);
      if (bucket) bucket.push(i);
      else this.map.set(key, [i]);
    }
  }

  private keyOf(wx: number, wy: number): number {
    // 16-bit interleave: fine for world coords well under ±500k units.
    const cx = Math.floor(wx / this.cell) & 0xffff;
    const cy = Math.floor(wy / this.cell) & 0xffff;
    return cx * 0x10000 + cy;
  }

  /** Nearest node whose disc (+`slack`) covers the world point, or -1. */
  pick(wx: number, wy: number, slack = 3): number {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    const cx = Math.floor(wx / this.cell);
    const cy = Math.floor(wy / this.cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = ((cx + dx) & 0xffff) * 0x10000 + ((cy + dy) & 0xffff);
        const bucket = this.map.get(key);
        if (!bucket) continue;
        for (const i of bucket) {
          const dist = Math.hypot(wx - (this.x[i] as number), wy - (this.y[i] as number));
          if (dist <= (this.r[i] as number) + slack && dist < bestDist) {
            best = i;
            bestDist = dist;
          }
        }
      }
    }
    return best;
  }
}
