/**
 * The Graph stage's imperative world — every byte of state a canvas frame
 * needs, and the frame itself. Pure TypeScript: no Preact, no DOM reads at
 * module scope, no `requestAnimationFrame`. The renderer half (sizing, media
 * queries, the rAF gate, pointer wiring) lives in `useGraphCanvas.ts`; this
 * file is what that hook drives, and what the unit tests exercise directly.
 *
 * Perf model (tens of thousands of nodes):
 *  - one 2D canvas, redrawn on demand — the rAF loop runs only while an
 *    animation is live (`animUntil`), never idles;
 *  - nodes batched by precomputed color bucket (status × saturation-ramp
 *    step) so a frame issues a handful of fills, not 50k style changes;
 *  - viewport culling per cluster circle, then per node;
 *  - level-of-detail: clusters whose dots would land under ~2px apart draw
 *    as ONE aggregate disc with a count;
 *  - hover picking via a uniform spatial hash (layout.ts NodeGrid).
 *
 * Animations (all event-driven, all cheap):
 *  - first snapshot BLOOMS: dots grow in radially from each hub, staggered
 *    by distance; later refreshes pop only the newcomers at cluster rims;
 *  - a node whose STATUS changed since the last refresh fires a one-shot
 *    expanding ring, so lifecycle transitions are visible live;
 *  - camera EASES for Fit view, double-click zoom, and click-a-hub framing
 *    (wheel/drag stay immediate and cancel any camera animation);
 *  - the hover ring grows in and the previous one fades out;
 *  - under prefers-reduced-motion everything collapses: entrances draw at end
 *    state, rings are skipped, and the camera snaps instead of easing. The
 *    gate is the settable `reduced` field — the hook keeps it live off the
 *    media query, so an OS-level toggle lands without a remount.
 */
import {
  GraphLayout,
  HUB_R,
  type LayoutResult,
  NODE_SPACING,
  NodeGrid,
} from '@/renderer/graph/layout';
import { BUCKET_COLORS, bucketOf, LEGEND_LABELS } from '@/renderer/graph/palette';
import { commas } from '@/renderer/lib/format';
import { easeInOutCubic } from '@/renderer/lib/motion';
import { GRAPH_NODE_STATUSES, type GraphNodeStatus, type GraphSnapshot } from '@/types';

/** Below this screen-px slot spacing a cluster draws as one aggregate disc. */
export const AGGREGATE_BELOW_PX = 2.2;
/** Node screen radius under which dots draw as squares (rect ≪ arc). */
export const RECT_BELOW_PX = 1.4;
export const ZOOM_MAX = 16;
/** How far below fit-scale the camera may zoom out. */
export const ZOOM_OUT_SLACK = 0.35;

/** Per-node grow-in duration; the first snapshot staggers starts on top. */
export const ENTER_MS = 340;
/** Max extra stagger a far-from-hub dot waits before growing in. */
export const BLOOM_SPREAD_MS = 650;
/** One-shot status-change ring lifetime. */
export const FLASH_MS = 700;
/** Hover ring grow-in / fade-out. */
export const HOVER_MS = 140;
/** Camera easing for fit / frame-a-cluster / double-click. */
export const CAM_MS = 450;

/** Most status-change rings one refresh may fire (a resync must not storm). */
const FLASH_BUDGET = 400;

/** Slight overshoot so entrances read as a pop, not a fade. */
export const easeOutBack = (t: number): number => {
  const c = 1.35;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export interface CamAnim {
  fx: number;
  fy: number;
  fs: number;
  tx: number;
  ty: number;
  ts: number;
  start: number;
  dur: number;
}

/** The tooltip model — a point beside the pointer plus its lines of copy. */
export interface Tip {
  left: number;
  top: number;
  title: string;
  lines: string[];
}

export type HoverHit = { kind: 'node'; index: number } | { kind: 'hub'; index: number };
export type Hover = HoverHit | null;

/** Theme colors the canvas paints with; the hook fills them from CSS vars. */
export interface GraphColors {
  text: string;
  muted: string;
  faint: string;
  border: string;
  surface: string;
}

export interface SnapshotOptions {
  /** The reduced-motion gate for THIS refresh; also latched onto the world. */
  reduced: boolean;
  /** Clock override for tests; defaults to `performance.now()`. */
  now?: number;
}

/** A screen point, in CSS pixels relative to the canvas. */
export interface ScreenPoint {
  sx: number;
  sy: number;
}

/**
 * Everything imperative the Graph canvas owns. One instance lives for as long
 * as the stage is mounted; nothing here re-renders Preact.
 */
export class GraphWorld {
  readonly engine = new GraphLayout();
  snapshot: GraphSnapshot | null = null;
  layout: LayoutResult | null = null;
  grid: NodeGrid | null = null;
  /** Per-node palette bucket (status × ramp step), parallel to snapshot. */
  buckets: Uint16Array | null = null;
  idxByPk: Map<string, number> | null = null;
  cam: Camera = { x: 0, y: 0, scale: 1 };
  camAnim: CamAnim | null = null;
  fitScale = 1;
  fitted = false;
  dragging = false;
  dragFrom: { sx: number; sy: number; camX: number; camY: number } | null = null;
  downAt: ScreenPoint | null = null;
  pointer: ScreenPoint | null = null;
  hover: Hover = null;
  hoverAt = 0;
  lastHover: { hit: HoverHit; at: number } | null = null;
  /** pk → perf.now() its grow-in starts (future = still waiting to bloom). */
  readonly born = new Map<string, number>();
  /** pk → perf.now() its status-change ring fired. */
  readonly flash = new Map<string, number>();
  lastStatusByPk: Map<string, number> | null = null;
  /** Latest instant any entrance is still animating (skip lookups after). */
  enterUntil = 0;
  /** Latest instant ANY animation is live — the rAF loop's stop condition. */
  animUntil = 0;
  /** The hook's pending rAF handle (0 = none); coalesces redraw requests. */
  raf = 0;
  /** True while the OS asks for minimized motion — kept live by the hook. */
  reduced = false;
  /** Statuses the legend currently hides. */
  hidden: ReadonlySet<GraphNodeStatus> = new Set();
  colors: GraphColors = {
    text: '#ececee',
    muted: '#9a9aa2',
    faint: '#66666e',
    border: '#26262b',
    surface: '#141417',
  };
  mono = 'ui-monospace, Menlo, monospace';
  /** Viewport in CSS pixels, plus the backing-store ratio the hook set. */
  vw = 1;
  vh = 1;
  dpr = 1;

  private readonly bucketLists: number[][] = BUCKET_COLORS.map(() => []);

  setViewport(vw: number, vh: number, dpr = 1): void {
    this.vw = vw;
    this.vh = vh;
    this.dpr = dpr;
  }

  /** Extend the "something is animating" window the rAF loop rides. */
  private extendAnim(until: number): void {
    if (until > this.animUntil) this.animUntil = until;
  }

  // --- Data → layout (slot-stable) + animation bookkeeping -------------------

  /**
   * Adopt a snapshot: re-run the slot-stable layout, rebuild the pick grid and
   * the color buckets, then register the entrances and status-change rings
   * this refresh earned.
   */
  setSnapshot(snapshot: GraphSnapshot | null, opts: SnapshotOptions): void {
    const reduced = opts.reduced;
    this.reduced = reduced;
    this.snapshot = snapshot;
    if (snapshot === null) {
      this.layout = null;
      this.grid = null;
      this.buckets = null;
      this.idxByPk = null;
      return;
    }
    const now = opts.now ?? performance.now();
    const layout = this.engine.apply(snapshot);
    this.layout = layout;
    this.grid = new NodeGrid(layout.x, layout.y, layout.r);

    const n = snapshot.pks.length;
    const buckets = new Uint16Array(n);
    const idxByPk = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      buckets[i] = bucketOf(snapshot.statuses[i] as number, snapshot.progress[i] as number);
      idxByPk.set(snapshot.pks[i] as string, i);
    }
    this.buckets = buckets;
    this.idxByPk = idxByPk;

    // Entrances: the FIRST snapshot blooms outward from each hub (delay by
    // distance from the cluster core); later refreshes pop only pks ABSENT
    // from the PREVIOUS snapshot (lastStatusByPk holds its full membership).
    // `born` is purely the in-flight animation map — it empties as entrances
    // finish, so it can never decide newcomer-ness. Reduced motion registers
    // no entrances at all: new dots appear at full size.
    const prevMembers = this.lastStatusByPk;
    const firstSnapshot = prevMembers === null;
    const nextStatus = new Map<string, number>();
    let enterUntil = this.enterUntil;
    for (let i = 0; i < n; i++) {
      const pk = snapshot.pks[i] as string;
      nextStatus.set(pk, snapshot.statuses[i] as number);
      if (reduced) continue;
      if ((firstSnapshot || !prevMembers.has(pk)) && !this.born.has(pk)) {
        let delay = 0;
        if (firstSnapshot) {
          const c = layout.clusters[snapshot.hubIndex[i] as number];
          const dist = c
            ? Math.hypot((layout.x[i] as number) - c.x, (layout.y[i] as number) - c.y)
            : 0;
          delay = Math.min(BLOOM_SPREAD_MS, Math.max(0, (dist - HUB_R) * 1.1));
        }
        const start = now + delay;
        this.born.set(pk, start);
        if (start + ENTER_MS > enterUntil) enterUntil = start + ENTER_MS;
      }
    }
    // Retire finished entrances so the per-frame lookup set stays small.
    for (const [pk, at] of this.born) {
      if (now - at > ENTER_MS) this.born.delete(pk);
    }
    this.enterUntil = enterUntil;
    this.extendAnim(enterUntil);

    // Status-change rings: visible lifecycle transitions between refreshes.
    if (prevMembers !== null && !reduced) {
      let fired = 0;
      for (const [pk, statusIdx] of nextStatus) {
        const before = prevMembers.get(pk);
        if (before !== undefined && before !== statusIdx && fired < FLASH_BUDGET) {
          this.flash.set(pk, now);
          fired += 1;
        }
      }
      if (fired > 0) this.extendAnim(now + FLASH_MS);
    }
    this.lastStatusByPk = nextStatus;
  }

  // --- Frame -----------------------------------------------------------------

  /**
   * Advance time-based animation state (today: the camera glide) to `tsMs`.
   * Returns whether another frame is needed — the ONLY stop condition the rAF
   * loop consults, so it never idles.
   */
  step(tsMs: number): boolean {
    const anim = this.camAnim;
    if (anim !== null) {
      const t = clamp01((tsMs - anim.start) / anim.dur);
      const e = easeInOutCubic(t);
      this.cam.x = anim.fx + (anim.tx - anim.fx) * e;
      this.cam.y = anim.fy + (anim.ty - anim.fy) * e;
      this.cam.scale = anim.fs + (anim.ts - anim.fs) * e;
      if (t >= 1) this.camAnim = null;
    }
    return tsMs < this.animUntil || this.camAnim !== null;
  }

  /**
   * Paint one frame. Never schedules anything itself — it returns whether the
   * caller should ask for another frame (the rAF gate lives in the hook).
   */
  draw(ctx: CanvasRenderingContext2D): boolean {
    const now = performance.now();
    const { vw, vh, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    const { snapshot, layout, cam, colors } = this;
    if (!snapshot || !layout || snapshot.pks.length + snapshot.hubs.length === 0) return false;

    // Camera easing (fit / frame / double-click) — interaction cancels it.
    this.step(now);

    const toSX = (wx: number): number => (wx - cam.x) * cam.scale + vw / 2;
    const toSY = (wy: number): number => (wy - cam.y) * cam.scale + vh / 2;
    const half = { x: vw / 2 / cam.scale, y: vh / 2 / cam.scale };
    const view = {
      minX: cam.x - half.x,
      maxX: cam.x + half.x,
      minY: cam.y - half.y,
      maxY: cam.y + half.y,
    };

    const hidden = this.hidden;
    const hiddenIdx = new Set<number>();
    GRAPH_NODE_STATUSES.forEach((s, i) => {
      if (hidden.has(s)) hiddenIdx.add(i);
    });

    // Chain links: self hub → each target hub, one faint hairline each.
    const selfCluster = layout.clusters[0];
    if (selfCluster) {
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let hIdx = 1; hIdx < layout.clusters.length; hIdx++) {
        const c = layout.clusters[hIdx];
        if (!c) continue;
        ctx.moveTo(toSX(selfCluster.x), toSY(selfCluster.y));
        ctx.lineTo(toSX(c.x), toSY(c.y));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    const aggregate = NODE_SPACING * cam.scale < AGGREGATE_BELOW_PX;
    const entering = !this.reduced && now < this.enterUntil;
    const lists = this.bucketLists;

    for (let hIdx = 0; hIdx < layout.clusters.length; hIdx++) {
      const c = layout.clusters[hIdx];
      if (!c) continue;
      if (
        c.x + c.r < view.minX ||
        c.x - c.r > view.maxX ||
        c.y + c.r < view.minY ||
        c.y - c.r > view.maxY
      ) {
        continue; // cluster fully off-screen
      }

      if (aggregate) {
        let visible = 0;
        for (const i of c.members) {
          if (!hiddenIdx.has(snapshot.statuses[i] as number)) visible += 1;
        }
        const sx = toSX(c.x);
        const sy = toSY(c.y);
        const sr = Math.max(5, c.r * cam.scale);
        ctx.fillStyle = colors.surface;
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (sr > 13) {
          ctx.fillStyle = colors.muted;
          ctx.font = `10px ${this.mono}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(commas(visible), sx, sy);
        }
        continue;
      }

      // Faint cluster boundary — structure without weight.
      ctx.strokeStyle = colors.border;
      ctx.globalAlpha = 0.14;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(toSX(c.x), toSY(c.y), c.r * cam.scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Batched member pass: bucket → one fill.
      const used: number[] = [];
      for (const i of c.members) {
        const statusIdx = snapshot.statuses[i] as number;
        if (hiddenIdx.has(statusIdx)) continue;
        const wx = layout.x[i] as number;
        const wy = layout.y[i] as number;
        const wr = layout.r[i] as number;
        if (
          wx + wr < view.minX ||
          wx - wr > view.maxX ||
          wy + wr < view.minY ||
          wy - wr > view.maxY
        ) {
          continue;
        }
        const bucket = (this.buckets as Uint16Array)[i] as number;
        const list = lists[bucket] as number[];
        if (list.length === 0) used.push(bucket);
        list.push(i);
      }
      for (const bucket of used) {
        const list = lists[bucket] as number[];
        ctx.fillStyle = BUCKET_COLORS[bucket] as string;
        ctx.beginPath();
        for (const i of list) {
          const sx = toSX(layout.x[i] as number);
          const sy = toSY(layout.y[i] as number);
          let sr = (layout.r[i] as number) * cam.scale;
          if (entering) {
            const bornAt = this.born.get(snapshot.pks[i] as string);
            if (bornAt !== undefined) {
              const k = (now - bornAt) / ENTER_MS;
              if (k <= 0) continue; // not born yet — blooming outward
              if (k < 1) sr *= easeOutBack(k);
            }
          }
          if (sr < RECT_BELOW_PX) {
            ctx.rect(sx - 0.75, sy - 0.75, 1.5, 1.5);
          } else {
            ctx.moveTo(sx + sr, sy);
            ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          }
        }
        ctx.fill();
        list.length = 0;
      }
    }

    // Hub cores + labels (over the dots).
    for (let hIdx = 0; hIdx < layout.clusters.length; hIdx++) {
      const c = layout.clusters[hIdx];
      const hub = snapshot.hubs[hIdx];
      if (!c || !hub) continue;
      const sx = toSX(c.x);
      const sy = toSY(c.y);
      if (sx < -60 || sx > vw + 60 || sy < -60 || sy > vh + 60) continue;
      const coreR = Math.max(3.5, HUB_R * 0.55 * cam.scale);
      ctx.fillStyle = colors.surface;
      ctx.strokeStyle = hub.kind === 'self' ? colors.text : colors.border;
      ctx.lineWidth = hub.kind === 'self' ? 1.5 : 1;
      ctx.beginPath();
      ctx.arc(sx, sy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (c.r * cam.scale > 30) {
        const name = hub.username !== null ? `@${hub.username}` : hub.pk;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `11px ${this.mono}`;
        ctx.fillStyle = hub.kind === 'self' ? colors.text : colors.muted;
        ctx.fillText(hub.kind === 'self' ? `${name} · you` : name, sx, sy + coreR + 5);
        ctx.font = `9px ${this.mono}`;
        ctx.fillStyle = colors.faint;
        ctx.fillText(commas(hub.memberCount), sx, sy + coreR + 19);
      }
    }

    // Status-change rings: one-shot, expanding and fading (skipped whole
    // under reduced motion — their end state is nothing).
    if (this.reduced) this.flash.clear();
    if (this.flash.size > 0 && !aggregate) {
      for (const [pk, at] of this.flash) {
        const t = (now - at) / FLASH_MS;
        if (t >= 1) {
          this.flash.delete(pk);
          continue;
        }
        const i = this.idxByPk?.get(pk);
        if (i === undefined || hiddenIdx.has(snapshot.statuses[i] as number)) continue;
        const sx = toSX(layout.x[i] as number);
        const sy = toSY(layout.y[i] as number);
        if (sx < -20 || sx > vw + 20 || sy < -20 || sy > vh + 20) continue;
        const sr = (layout.r[i] as number) * cam.scale;
        ctx.strokeStyle = BUCKET_COLORS[(this.buckets as Uint16Array)[i] as number] as string;
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, sr + 2 + 12 * easeInOutCubic(t), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Hover ring: grows in on the current target, fades on the previous.
    const drawHoverRing = (hit: HoverHit, k: number): void => {
      ctx.strokeStyle = colors.text;
      ctx.globalAlpha = k;
      ctx.lineWidth = 1.5;
      if (hit.kind === 'node') {
        const i = hit.index;
        if (i >= snapshot.pks.length) {
          ctx.globalAlpha = 1;
          return;
        }
        const sx = toSX(layout.x[i] as number);
        const sy = toSY(layout.y[i] as number);
        const sr = Math.max(2.5, (layout.r[i] as number) * cam.scale);
        const c = layout.clusters[snapshot.hubIndex[i] as number];
        if (c) {
          ctx.strokeStyle = colors.muted;
          ctx.globalAlpha = 0.6 * k;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(toSX(c.x), toSY(c.y));
          ctx.stroke();
          ctx.strokeStyle = colors.text;
          ctx.globalAlpha = k;
          ctx.lineWidth = 1.5;
        }
        ctx.beginPath();
        ctx.arc(sx, sy, sr + 1 + 1.5 * k, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const c = layout.clusters[hit.index];
        if (c) {
          const r = aggregate ? Math.max(5, c.r * cam.scale) : Math.max(6, HUB_R * 0.55 * cam.scale);
          ctx.beginPath();
          ctx.arc(toSX(c.x), toSY(c.y), r + 3 * k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    };
    if (this.hover !== null) {
      drawHoverRing(
        this.hover,
        this.reduced ? 1 : easeInOutCubic(clamp01((now - this.hoverAt) / HOVER_MS)),
      );
    }
    if (this.lastHover !== null) {
      const t = (now - this.lastHover.at) / HOVER_MS;
      if (this.reduced || t >= 1) this.lastHover = null;
      else drawHoverRing(this.lastHover.hit, 1 - easeInOutCubic(clamp01(t)));
    }

    // Keep the loop alive exactly as long as something is animating.
    return performance.now() < this.animUntil || this.camAnim !== null;
  }

  // --- Camera ----------------------------------------------------------------

  toWorld(sx: number, sy: number): { wx: number; wy: number } {
    return {
      wx: this.cam.x + (sx - this.vw / 2) / this.cam.scale,
      wy: this.cam.y + (sy - this.vh / 2) / this.cam.scale,
    };
  }

  private startCamAnim(tx: number, ty: number, ts: number, dur: number): void {
    if (this.reduced) {
      // No eased glide under reduced motion — land on the target at once.
      this.camAnim = null;
      this.cam = { x: tx, y: ty, scale: ts };
      return;
    }
    const now = performance.now();
    this.camAnim = { fx: this.cam.x, fy: this.cam.y, fs: this.cam.scale, tx, ty, ts, start: now, dur };
    this.extendAnim(now + dur);
  }

  private fitTo(
    b: { minX: number; minY: number; maxX: number; maxY: number },
    animate: boolean,
    pad = 0.9,
  ): void {
    const bw = Math.max(1, b.maxX - b.minX);
    const bh = Math.max(1, b.maxY - b.minY);
    const scale = Math.min(ZOOM_MAX, Math.max(0.002, Math.min(this.vw / bw, this.vh / bh) * pad));
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    if (animate) {
      this.startCamAnim(cx, cy, scale, CAM_MS);
    } else {
      this.camAnim = null;
      this.cam = { x: cx, y: cy, scale };
    }
  }

  /** Frame the whole graph. Returns false (nothing done) when unlaid out. */
  fit(animate: boolean): boolean {
    const layout = this.layout;
    if (!layout) return false;
    this.fitTo(layout.bounds, animate);
    // Fit-scale anchors the zoom-out clamp; compute it from the same math.
    const bw = Math.max(1, layout.bounds.maxX - layout.bounds.minX);
    const bh = Math.max(1, layout.bounds.maxY - layout.bounds.minY);
    this.fitScale = Math.min(ZOOM_MAX, Math.max(0.002, Math.min(this.vw / bw, this.vh / bh) * 0.9));
    return true;
  }

  /** Frame one cluster (hub click): ease the camera onto its circle. */
  fitCluster(hIdx: number): boolean {
    const c = this.layout?.clusters[hIdx];
    if (!c) return false;
    this.fitTo({ minX: c.x - c.r, maxX: c.x + c.r, minY: c.y - c.r, maxY: c.y + c.r }, true, 0.85);
    return true;
  }

  /** Zoom about a screen point, clamped to [fitScale × slack, ZOOM_MAX]. */
  zoomAt(factor: number, sx: number, sy: number, animated: boolean): void {
    const min = this.fitScale * ZOOM_OUT_SLACK;
    const target = Math.min(ZOOM_MAX, Math.max(min, this.cam.scale * factor));
    const before = this.toWorld(sx, sy);
    const tx = before.wx - (sx - this.vw / 2) / target;
    const ty = before.wy - (sy - this.vh / 2) / target;
    if (animated) {
      this.startCamAnim(tx, ty, target, 260);
    } else {
      this.camAnim = null;
      this.cam = { x: tx, y: ty, scale: target };
    }
  }

  // --- Drag ------------------------------------------------------------------

  beginDrag(sx: number, sy: number): void {
    this.camAnim = null; // grabbing the world stops any camera glide
    this.dragging = true;
    this.dragFrom = { sx, sy, camX: this.cam.x, camY: this.cam.y };
    this.downAt = { sx, sy };
  }

  /** Track the pointer; returns true when the move panned the camera. */
  dragTo(sx: number, sy: number): boolean {
    this.pointer = { sx, sy };
    const from = this.dragFrom;
    if (!this.dragging || !from) return false;
    this.cam.x = from.camX - (sx - from.sx) / this.cam.scale;
    this.cam.y = from.camY - (sy - from.sy) / this.cam.scale;
    return true;
  }

  /** End a press; returns where it went down so a click can be told apart. */
  endDrag(): ScreenPoint | null {
    const down = this.downAt;
    this.dragging = false;
    this.dragFrom = null;
    this.downAt = null;
    return down;
  }

  // --- Picking ---------------------------------------------------------------

  /** Hit-test a screen point: the node under it, else the hub core, else null. */
  pick(sx: number, sy: number): Hover {
    const { snapshot, layout, grid } = this;
    if (!snapshot || !layout) return null;
    const { wx, wy } = this.toWorld(sx, sy);
    const aggregate = NODE_SPACING * this.cam.scale < AGGREGATE_BELOW_PX;
    let next: Hover = null;
    if (!aggregate && grid) {
      const i = grid.pick(wx, wy, 4 / this.cam.scale);
      if (
        i >= 0 &&
        !this.hidden.has(GRAPH_NODE_STATUSES[snapshot.statuses[i] as number] as GraphNodeStatus)
      ) {
        next = { kind: 'node', index: i };
      }
    }
    if (next === null) {
      for (let hIdx = 0; hIdx < layout.clusters.length; hIdx++) {
        const c = layout.clusters[hIdx];
        if (!c) continue;
        const coreWorldR = aggregate ? c.r : Math.max(HUB_R * 0.55, 8 / this.cam.scale);
        if (Math.hypot(wx - c.x, wy - c.y) <= coreWorldR) {
          next = { kind: 'hub', index: hIdx };
          break;
        }
      }
    }
    return next;
  }

  /**
   * The tooltip model for a hit. The desired spot sits beside the pointer; the
   * component clamps it to the stage with the bubble's MEASURED size.
   */
  tipFor(hit: HoverHit, pointer: ScreenPoint): Tip | null {
    const snapshot = this.snapshot;
    if (!snapshot) return null;
    const left = pointer.sx + 14;
    const top = pointer.sy + 12;
    if (hit.kind === 'hub') {
      const hub = snapshot.hubs[hit.index];
      if (!hub) return null;
      return {
        left,
        top,
        title: hub.username !== null ? `@${hub.username}` : hub.pk,
        lines: [
          hub.kind === 'self' ? 'You' : `Chain target · ${hub.targetStatus ?? 'active'}`,
          `${commas(hub.memberCount)} known accounts`,
          'Click to frame this cluster',
        ],
      };
    }
    const i = hit.index;
    const status = GRAPH_NODE_STATUSES[snapshot.statuses[i] as number] as GraphNodeStatus;
    const lines: string[] = [LEGEND_LABELS[status]];
    const p = snapshot.progress[i] as number;
    if (p >= 0) {
      lines.push(
        status === 'waiting'
          ? `${Math.round(p * 100)}% of the follow-back wait`
          : `${Math.round(p * 100)}% of the hold`,
      );
    }
    const followerCount = snapshot.followers[i] as number;
    if (followerCount >= 0) lines.push(`${commas(followerCount)} followers`);
    const hub = snapshot.hubs[snapshot.hubIndex[i] as number];
    if (hub) lines.push(`via ${hub.username !== null ? `@${hub.username}` : hub.pk}`);
    const username = snapshot.usernames[i];
    return {
      left,
      top,
      title: username !== null && username !== undefined ? `@${username}` : `#${snapshot.pks[i]}`,
      lines,
    };
  }

  // --- Hover -----------------------------------------------------------------

  /** Move the hover target; returns true when the caller should redraw. */
  setHover(next: Hover, now = performance.now()): boolean {
    const prev = this.hover;
    const same =
      (prev === null && next === null) ||
      (prev !== null && next !== null && prev.kind === next.kind && prev.index === next.index);
    if (same) return false;
    if (prev !== null) this.lastHover = { hit: prev, at: now };
    this.hover = next;
    this.hoverAt = now;
    this.extendAnim(now + HOVER_MS);
    return true;
  }
}
