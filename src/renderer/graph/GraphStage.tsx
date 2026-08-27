/** @jsx h */
/**
 * The Graph stage — the canvas filling the stage body (right of the console,
 * under the stage bar) while the Graph tab is selected. It stays MOUNTED in
 * both stage modes (the native Instagram view simply covers it), so the
 * camera and the layout's slot maps survive round-trips through the tab.
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
 *  - the hover ring grows in and the previous one fades out.
 */
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  GraphLayout,
  HUB_R,
  type LayoutResult,
  NODE_SPACING,
  NodeGrid,
} from '@/renderer/graph/layout';
import {
  BUCKET_COLORS,
  bucketOf,
  LEGEND_LABELS,
  legendColor,
  legendColorWashed,
  STATUS_COLORS,
} from '@/renderer/graph/palette';
import type { GraphBoard } from '@/renderer/hooks/useGraphBoard';
import { commas } from '@/renderer/lib/format';
import { Button } from '@/renderer/ui/Button';
import { Icon } from '@/renderer/ui/Icon';
import { GRAPH_NODE_STATUSES, type GraphNodeStatus, type GraphSnapshot } from '@/types';

/** Below this screen-px slot spacing a cluster draws as one aggregate disc. */
const AGGREGATE_BELOW_PX = 2.2;
/** Node screen radius under which dots draw as squares (rect ≪ arc). */
const RECT_BELOW_PX = 1.4;
const ZOOM_MAX = 16;
/** How far below fit-scale the camera may zoom out. */
const ZOOM_OUT_SLACK = 0.35;

/** Per-node grow-in duration; the first snapshot staggers starts on top. */
const ENTER_MS = 340;
/** Max extra stagger a far-from-hub dot waits before growing in. */
const BLOOM_SPREAD_MS = 650;
/** One-shot status-change ring lifetime. */
const FLASH_MS = 700;
/** Hover ring grow-in / fade-out. */
const HOVER_MS = 140;
/** Camera easing for fit / frame-a-cluster / double-click. */
const CAM_MS = 450;

const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
/** Slight overshoot so entrances read as a pop, not a fade. */
const easeOutBack = (t: number): number => {
  const c = 1.35;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface CamAnim {
  fx: number;
  fy: number;
  fs: number;
  tx: number;
  ty: number;
  ts: number;
  start: number;
  dur: number;
}

interface Tip {
  left: number;
  top: number;
  title: string;
  lines: string[];
}

type HoverHit = { kind: 'node'; index: number } | { kind: 'hub'; index: number };
type Hover = HoverHit | null;

/** Everything imperative, owned by refs so redraws never re-render Preact. */
interface World {
  engine: GraphLayout;
  snapshot: GraphSnapshot | null;
  layout: LayoutResult | null;
  grid: NodeGrid | null;
  /** Per-node palette bucket (status × ramp step), parallel to snapshot. */
  buckets: Uint16Array | null;
  idxByPk: Map<string, number> | null;
  cam: Camera;
  camAnim: CamAnim | null;
  fitScale: number;
  fitted: boolean;
  dragging: boolean;
  dragFrom: { sx: number; sy: number; camX: number; camY: number } | null;
  downAt: { sx: number; sy: number } | null;
  pointer: { sx: number; sy: number } | null;
  hover: Hover;
  hoverAt: number;
  lastHover: { hit: HoverHit; at: number } | null;
  /** pk → perf.now() its grow-in starts (future = still waiting to bloom). */
  born: Map<string, number>;
  /** pk → perf.now() its status-change ring fired. */
  flash: Map<string, number>;
  lastStatusByPk: Map<string, number> | null;
  /** Latest instant any entrance is still animating (skip lookups after). */
  enterUntil: number;
  /** Latest instant ANY animation is live — the rAF loop's stop condition. */
  animUntil: number;
  raf: number;
  bucketLists: number[][];
  colors: { text: string; muted: string; faint: string; border: string; surface: string };
  mono: string;
}

const cssVar = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
};

/** A legend swatch: flat for plain statuses, washed→full ramp for timed ones. */
const swatchStyle = (status: GraphNodeStatus): string =>
  STATUS_COLORS[status].timed
    ? `background:linear-gradient(90deg, ${legendColorWashed(status)}, ${legendColor(status)})`
    : `background:${legendColor(status)}`;

export interface GraphStageProps {
  board: GraphBoard;
  /** True while the Graph stage tab is selected (the native tab is hidden). */
  active: boolean;
}

export function GraphStage({ board, active }: GraphStageProps): h.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [dragCursor, setDragCursor] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);

  const w = useRef<World | null>(null);
  if (w.current === null) {
    w.current = {
      engine: new GraphLayout(),
      snapshot: null,
      layout: null,
      grid: null,
      buckets: null,
      idxByPk: null,
      cam: { x: 0, y: 0, scale: 1 },
      camAnim: null,
      fitScale: 1,
      fitted: false,
      dragging: false,
      dragFrom: null,
      downAt: null,
      pointer: null,
      hover: null,
      hoverAt: 0,
      lastHover: null,
      born: new Map(),
      flash: new Map(),
      lastStatusByPk: null,
      enterUntil: 0,
      animUntil: 0,
      raf: 0,
      bucketLists: BUCKET_COLORS.map(() => []),
      colors: { text: '#ececee', muted: '#9a9aa2', faint: '#66666e', border: '#26262b', surface: '#141417' },
      mono: 'ui-monospace, Menlo, monospace',
    };
  }

  const hiddenRef = useRef(board.hidden);
  hiddenRef.current = board.hidden;

  /** Set by the mount effect; snapshot/filter effects call through these. */
  const redrawRef = useRef<() => void>(() => {});
  const fitRef = useRef<(animate: boolean) => void>(() => {});
  const repickRef = useRef<() => void>(() => {});

  // --- Imperative canvas world (mounted once) -------------------------------
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const world = w.current;
    if (!host || !canvas || !world) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    world.colors = {
      text: cssVar('--text', world.colors.text),
      muted: cssVar('--muted', world.colors.muted),
      faint: cssVar('--faint', world.colors.faint),
      border: cssVar('--border-strong', world.colors.border),
      surface: cssVar('--elevated', world.colors.surface),
    };
    world.mono = cssVar('--mono', world.mono);

    const viewSize = (): { vw: number; vh: number } => ({
      vw: canvas.width / (window.devicePixelRatio || 1),
      vh: canvas.height / (window.devicePixelRatio || 1),
    });

    const animate = (until: number): void => {
      if (until > world.animUntil) world.animUntil = until;
    };

    const draw = (): void => {
      const now = performance.now();
      const dpr = window.devicePixelRatio || 1;
      const { vw, vh } = viewSize();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      const { snapshot, layout, cam, colors } = world;
      if (!snapshot || !layout || snapshot.pks.length + snapshot.hubs.length === 0) return;

      // Camera easing (fit / frame / double-click) — interaction cancels it.
      const anim = world.camAnim;
      if (anim !== null) {
        const t = clamp01((now - anim.start) / anim.dur);
        const e = easeInOutCubic(t);
        cam.x = anim.fx + (anim.tx - anim.fx) * e;
        cam.y = anim.fy + (anim.ty - anim.fy) * e;
        cam.scale = anim.fs + (anim.ts - anim.fs) * e;
        if (t >= 1) world.camAnim = null;
      }

      const toSX = (wx: number): number => (wx - cam.x) * cam.scale + vw / 2;
      const toSY = (wy: number): number => (wy - cam.y) * cam.scale + vh / 2;
      const half = { x: vw / 2 / cam.scale, y: vh / 2 / cam.scale };
      const view = {
        minX: cam.x - half.x,
        maxX: cam.x + half.x,
        minY: cam.y - half.y,
        maxY: cam.y + half.y,
      };

      const hidden = hiddenRef.current;
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
      const entering = now < world.enterUntil;
      const lists = world.bucketLists;

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
            ctx.font = `10px ${world.mono}`;
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
          const bucket = (world.buckets as Uint16Array)[i] as number;
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
              const bornAt = world.born.get(snapshot.pks[i] as string);
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
          ctx.font = `11px ${world.mono}`;
          ctx.fillStyle = hub.kind === 'self' ? colors.text : colors.muted;
          ctx.fillText(hub.kind === 'self' ? `${name} · you` : name, sx, sy + coreR + 5);
          ctx.font = `9px ${world.mono}`;
          ctx.fillStyle = colors.faint;
          ctx.fillText(commas(hub.memberCount), sx, sy + coreR + 19);
        }
      }

      // Status-change rings: one-shot, expanding and fading.
      if (world.flash.size > 0 && !aggregate) {
        for (const [pk, at] of world.flash) {
          const t = (now - at) / FLASH_MS;
          if (t >= 1) {
            world.flash.delete(pk);
            continue;
          }
          const i = world.idxByPk?.get(pk);
          if (i === undefined || hiddenIdx.has(snapshot.statuses[i] as number)) continue;
          const sx = toSX(layout.x[i] as number);
          const sy = toSY(layout.y[i] as number);
          if (sx < -20 || sx > vw + 20 || sy < -20 || sy > vh + 20) continue;
          const sr = (layout.r[i] as number) * cam.scale;
          ctx.strokeStyle = BUCKET_COLORS[(world.buckets as Uint16Array)[i] as number] as string;
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
      if (world.hover !== null) {
        drawHoverRing(world.hover, easeInOutCubic(clamp01((now - world.hoverAt) / HOVER_MS)));
      }
      if (world.lastHover !== null) {
        const t = (now - world.lastHover.at) / HOVER_MS;
        if (t >= 1) world.lastHover = null;
        else drawHoverRing(world.lastHover.hit, 1 - easeInOutCubic(clamp01(t)));
      }

      // Keep the loop alive exactly as long as something is animating.
      if (performance.now() < world.animUntil || world.camAnim !== null) redraw();
    };

    const redraw = (): void => {
      if (world.raf !== 0) return;
      world.raf = requestAnimationFrame(() => {
        world.raf = 0;
        draw();
      });
    };

    const startCamAnim = (tx: number, ty: number, ts: number, dur: number): void => {
      const now = performance.now();
      world.camAnim = {
        fx: world.cam.x,
        fy: world.cam.y,
        fs: world.cam.scale,
        tx,
        ty,
        ts,
        start: now,
        dur,
      };
      animate(now + dur);
      redraw();
    };

    const fitTo = (
      b: { minX: number; minY: number; maxX: number; maxY: number },
      animateCam: boolean,
      pad = 0.9,
    ): void => {
      const { vw, vh } = viewSize();
      const bw = Math.max(1, b.maxX - b.minX);
      const bh = Math.max(1, b.maxY - b.minY);
      const scale = Math.min(ZOOM_MAX, Math.max(0.002, Math.min(vw / bw, vh / bh) * pad));
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      if (animateCam) {
        startCamAnim(cx, cy, scale, CAM_MS);
      } else {
        world.camAnim = null;
        world.cam = { x: cx, y: cy, scale };
        redraw();
      }
    };

    const fit = (animateCam: boolean): void => {
      const layout = world.layout;
      if (!layout) return;
      fitTo(layout.bounds, animateCam);
      // Fit-scale anchors the zoom-out clamp; compute it from the same math.
      const { vw, vh } = viewSize();
      const bw = Math.max(1, layout.bounds.maxX - layout.bounds.minX);
      const bh = Math.max(1, layout.bounds.maxY - layout.bounds.minY);
      world.fitScale = Math.min(ZOOM_MAX, Math.max(0.002, Math.min(vw / bw, vh / bh) * 0.9));
    };

    /** Frame one cluster (hub click): ease the camera onto its circle. */
    const fitCluster = (hIdx: number): void => {
      const c = world.layout?.clusters[hIdx];
      if (!c) return;
      fitTo({ minX: c.x - c.r, maxX: c.x + c.r, minY: c.y - c.r, maxY: c.y + c.r }, true, 0.85);
    };

    const toWorld = (sx: number, sy: number): { wx: number; wy: number } => {
      const { vw, vh } = viewSize();
      return {
        wx: world.cam.x + (sx - vw / 2) / world.cam.scale,
        wy: world.cam.y + (sy - vh / 2) / world.cam.scale,
      };
    };

    const setHover = (next: Hover): void => {
      const prev = world.hover;
      const same =
        (prev === null && next === null) ||
        (prev !== null && next !== null && prev.kind === next.kind && prev.index === next.index);
      if (same) return;
      const now = performance.now();
      if (prev !== null) world.lastHover = { hit: prev, at: now };
      world.hover = next;
      world.hoverAt = now;
      animate(now + HOVER_MS);
      redraw();
    };

    /** Hover pick at the last pointer position; updates the tooltip state. */
    const repick = (): void => {
      const { snapshot, layout, grid, pointer } = world;
      if (!snapshot || !layout || !pointer || world.dragging) {
        setHover(null);
        setTip(null);
        return;
      }
      const { wx, wy } = toWorld(pointer.sx, pointer.sy);
      const aggregate = NODE_SPACING * world.cam.scale < AGGREGATE_BELOW_PX;
      let next: Hover = null;
      if (!aggregate && grid) {
        const i = grid.pick(wx, wy, 4 / world.cam.scale);
        if (
          i >= 0 &&
          !hiddenRef.current.has(
            GRAPH_NODE_STATUSES[snapshot.statuses[i] as number] as GraphNodeStatus,
          )
        ) {
          next = { kind: 'node', index: i };
        }
      }
      if (next === null) {
        for (let hIdx = 0; hIdx < layout.clusters.length; hIdx++) {
          const c = layout.clusters[hIdx];
          if (!c) continue;
          const coreWorldR = aggregate ? c.r : Math.max(HUB_R * 0.55, 8 / world.cam.scale);
          if (Math.hypot(wx - c.x, wy - c.y) <= coreWorldR) {
            next = { kind: 'hub', index: hIdx };
            break;
          }
        }
      }
      setHover(next);

      if (next === null) {
        setTip(null);
        return;
      }
      const left = Math.min(pointer.sx + 14, host.clientWidth - 190);
      const top = Math.min(pointer.sy + 12, host.clientHeight - 96);
      if (next.kind === 'hub') {
        const hub = snapshot.hubs[next.index];
        if (!hub) return;
        setTip({
          left,
          top,
          title: hub.username !== null ? `@${hub.username}` : hub.pk,
          lines: [
            hub.kind === 'self' ? 'You' : `Chain target · ${hub.targetStatus ?? 'active'}`,
            `${commas(hub.memberCount)} known accounts`,
            'Click to frame this cluster',
          ],
        });
        return;
      }
      const i = next.index;
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
      setTip({
        left,
        top,
        title: username !== null && username !== undefined ? `@${username}` : `#${snapshot.pks[i]}`,
        lines,
      });
    };

    redrawRef.current = redraw;
    fitRef.current = fit;
    repickRef.current = repick;

    // --- Size tracking ------------------------------------------------------
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(host.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(host.clientHeight * dpr));
      if (!world.fitted && world.layout) {
        world.fitted = true;
        fit(false);
      }
      redraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // --- Interaction --------------------------------------------------------
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      world.camAnim = null; // grabbing the world stops any camera glide
      world.dragging = true;
      world.dragFrom = { sx: e.offsetX, sy: e.offsetY, camX: world.cam.x, camY: world.cam.y };
      world.downAt = { sx: e.offsetX, sy: e.offsetY };
      setDragCursor(true);
      setTip(null);
    };
    const onPointerMove = (e: PointerEvent): void => {
      world.pointer = { sx: e.offsetX, sy: e.offsetY };
      if (world.dragging && world.dragFrom) {
        world.cam.x = world.dragFrom.camX - (e.offsetX - world.dragFrom.sx) / world.cam.scale;
        world.cam.y = world.dragFrom.camY - (e.offsetY - world.dragFrom.sy) / world.cam.scale;
        redraw();
        return;
      }
      repick();
    };
    const onPointerUp = (e: PointerEvent): void => {
      const down = world.downAt;
      world.dragging = false;
      world.dragFrom = null;
      world.downAt = null;
      setDragCursor(false);
      // A press that never became a drag is a CLICK — on a hub, frame it.
      if (down && Math.hypot(e.offsetX - down.sx, e.offsetY - down.sy) < 5) {
        repick();
        if (world.hover?.kind === 'hub') fitCluster(world.hover.index);
      }
    };
    const endDrag = (): void => {
      world.dragging = false;
      world.dragFrom = null;
      world.downAt = null;
      setDragCursor(false);
    };
    const zoomAt = (factor: number, sx: number, sy: number, animated: boolean): void => {
      const min = world.fitScale * ZOOM_OUT_SLACK;
      const target = Math.min(ZOOM_MAX, Math.max(min, world.cam.scale * factor));
      const before = toWorld(sx, sy);
      const { vw, vh } = viewSize();
      const tx = before.wx - (sx - vw / 2) / target;
      const ty = before.wy - (sy - vh / 2) / target;
      if (animated) {
        startCamAnim(tx, ty, target, 260);
      } else {
        world.camAnim = null;
        world.cam = { x: tx, y: ty, scale: target };
        redraw();
        repick();
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0016), e.offsetX, e.offsetY, false);
    };
    const onDblClick = (e: MouseEvent): void => zoomAt(1.9, e.offsetX, e.offsetY, true);
    const onLeave = (): void => {
      world.pointer = null;
      repick();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      if (world.raf !== 0) cancelAnimationFrame(world.raf);
      world.raf = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Data → layout (slot-stable) + animation bookkeeping -------------------
  useEffect(() => {
    const world = w.current;
    if (!world) return;
    world.snapshot = board.snapshot;
    if (board.snapshot) {
      const snap = board.snapshot;
      const now = performance.now();
      world.layout = world.engine.apply(snap);
      world.grid = new NodeGrid(world.layout.x, world.layout.y, world.layout.r);

      const n = snap.pks.length;
      const buckets = new Uint16Array(n);
      const idxByPk = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        buckets[i] = bucketOf(snap.statuses[i] as number, snap.progress[i] as number);
        idxByPk.set(snap.pks[i] as string, i);
      }
      world.buckets = buckets;
      world.idxByPk = idxByPk;

      // Entrances: the FIRST snapshot blooms outward from each hub (delay by
      // distance from the cluster core); later refreshes pop newcomers now.
      const firstSnapshot = world.lastStatusByPk === null;
      const nextStatus = new Map<string, number>();
      let enterUntil = world.enterUntil;
      for (let i = 0; i < n; i++) {
        const pk = snap.pks[i] as string;
        nextStatus.set(pk, snap.statuses[i] as number);
        if (!world.born.has(pk)) {
          let delay = 0;
          if (firstSnapshot) {
            const c = world.layout.clusters[snap.hubIndex[i] as number];
            const dist = c
              ? Math.hypot((world.layout.x[i] as number) - c.x, (world.layout.y[i] as number) - c.y)
              : 0;
            delay = Math.min(BLOOM_SPREAD_MS, Math.max(0, (dist - HUB_R) * 1.1));
          }
          const start = now + delay;
          world.born.set(pk, start);
          if (start + ENTER_MS > enterUntil) enterUntil = start + ENTER_MS;
        }
      }
      // Retire finished entrances so the per-frame lookup set stays small.
      for (const [pk, at] of world.born) {
        if (now - at > ENTER_MS) world.born.delete(pk);
      }
      world.enterUntil = enterUntil;
      if (enterUntil > world.animUntil) world.animUntil = enterUntil;

      // Status-change rings: visible lifecycle transitions between refreshes.
      const prev = world.lastStatusByPk;
      if (prev !== null) {
        let fired = 0;
        for (const [pk, statusIdx] of nextStatus) {
          const before = prev.get(pk);
          if (before !== undefined && before !== statusIdx && fired < 400) {
            world.flash.set(pk, now);
            fired += 1;
          }
        }
        if (fired > 0 && now + FLASH_MS > world.animUntil) world.animUntil = now + FLASH_MS;
      }
      world.lastStatusByPk = nextStatus;

      if (!world.fitted && canvasRef.current && canvasRef.current.width > 1) {
        world.fitted = true;
        fitRef.current(false);
      }
    } else {
      world.layout = null;
      world.grid = null;
      world.buckets = null;
      world.idxByPk = null;
    }
    redrawRef.current();
    repickRef.current(); // keep the tooltip honest across live refreshes
  }, [board.snapshot]);

  // --- Legend filters -------------------------------------------------------
  useEffect(() => {
    redrawRef.current();
    repickRef.current();
  }, [board.hidden]);

  // Re-entering the stage replays the reveal (CSS) and repaints fresh.
  useEffect(() => {
    if (active) redrawRef.current();
  }, [active]);

  const snap = board.snapshot;
  const empty = snap !== null && snap.pks.length === 0;
  return (
    <div
      class={[
        'graph-stage',
        active ? 'on' : '',
        dragCursor ? 'dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={hostRef}
    >
      <canvas ref={canvasRef} />
      {board.loading ? (
        <div class="graph-empty">Reading the graph…</div>
      ) : snap === null ? (
        <div class="graph-empty">
          Nothing to draw yet — log in and let the engine read a target's followers.
        </div>
      ) : empty ? (
        <div class="graph-empty">The graph is empty so far. Start the engine to grow it.</div>
      ) : null}

      <div class={legendOpen ? 'graph-legend' : 'graph-legend collapsed'}>
        <button
          type="button"
          class="graph-legend__head"
          onClick={() => setLegendOpen((open) => !open)}
          aria-expanded={legendOpen}
        >
          <Icon name="circle-nodes" />
          <span>Legend</span>
          <span class="graph-legend__total num">{snap ? commas(snap.pks.length) : '—'}</span>
          <Icon name="chevron-down" class="graph-legend__chev" />
        </button>
        <div class="graph-legend__body">
          <div class="gleg">
            {GRAPH_NODE_STATUSES.map((status) => {
              const count = snap ? snap.counts[status] : 0;
              const off = board.hidden.has(status);
              return (
                <button
                  key={status}
                  type="button"
                  class={off ? 'gleg-row off' : 'gleg-row'}
                  title={off ? 'Show this status' : 'Hide this status'}
                  onClick={() => board.toggleStatus(status)}
                >
                  <span class="gleg-dot" style={swatchStyle(status)} />
                  <span class="gleg-label">{LEGEND_LABELS[status]}</span>
                  <span class="gleg-count num">{commas(count)}</span>
                </button>
              );
            })}
          </div>
          <div class="graph-legend__foot">
            <Button wide icon="expand" onClick={() => fitRef.current(true)}>
              Fit view
            </Button>
            <p class="graph-legend__hint">
              Drag to pan · scroll to zoom · click a cluster core to frame it. Timed dots
              saturate as their clock nears the deadline.
            </p>
          </div>
        </div>
      </div>

      {tip ? (
        <div class="graph-tip" style={`left:${tip.left}px;top:${tip.top}px`}>
          <div class="graph-tip__title">{tip.title}</div>
          {tip.lines.map((line) => (
            <div key={line} class="graph-tip__line">
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
