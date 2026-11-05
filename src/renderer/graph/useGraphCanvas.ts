/**
 * The Preact half of the Graph canvas: everything a {@link GraphWorld} cannot
 * own because it touches the DOM or the frame clock. The world stays pure and
 * unit-tested; this hook is the only place the canvas meets the browser.
 *
 * What it owns:
 *  - the host/canvas refs and the BACKING STORE. The canvas is sized in device
 *    pixels (`clientWidth × dpr`) while the world is told the CSS-pixel
 *    viewport, so one `setTransform(dpr, …)` per frame keeps every drawing
 *    coordinate in CSS units.
 *  - two media queries. A `(resolution: Ndppx)` query, RE-REGISTERED on each
 *    change, catches a window moved to a differently-scaled display: the
 *    ResizeObserver never fires there (the CSS box is unchanged), which used
 *    to leave a stale backing store — blurry dots and offset hit-testing. A
 *    `(prefers-reduced-motion: reduce)` query keeps `world.reduced` live, so
 *    an OS-level toggle lands WITHOUT a remount.
 *  - the rAF gate. `redraw()` coalesces requests into at most one pending
 *    frame, and the loop re-arms only while `GraphWorld.draw` reports an
 *    animation still running — it never idles. Teardown cancels the pending
 *    frame and removes every listener (observer, both queries, 7 on the
 *    canvas).
 *  - pointer/wheel/double-click wiring, and the only two pieces of canvas
 *    state Preact needs back: the tooltip model and the grab cursor.
 *
 * Everything else the canvas remembers lives in refs, so a redraw never
 * re-renders Preact.
 */
import type { RefObject } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { GraphWorld, type Tip } from '@/renderer/graph/world';
import type { GraphNodeStatus } from '@/types';

/** A press that travelled less than this (CSS px) is a click, not a drag. */
const CLICK_SLOP_PX = 5;
/** Wheel delta → zoom exponent. */
const WHEEL_ZOOM = 0.0016;
/** Double-click zoom step. */
const DBLCLICK_ZOOM = 1.9;

const cssVar = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
};

export interface GraphCanvas {
  /** The positioned stage box: the canvas fills it, the tooltip clamps into it. */
  hostRef: RefObject<HTMLDivElement>;
  canvasRef: RefObject<HTMLCanvasElement>;
  /** The imperative world the component's data effects feed. */
  world: GraphWorld;
  /** Tooltip model for the current hover, placed beside the pointer. */
  tip: Tip | null;
  /** True while a pan is in progress (drives the grab cursor). */
  dragCursor: boolean;
  /** Ask for a frame; coalesced into at most one pending rAF. */
  redraw(): void;
  /** Frame the whole graph — `animate` eases unless motion is reduced. */
  fit(animate: boolean): void;
  /** Re-pick under the last pointer position and refresh the tooltip. */
  repick(): void;
  /** Frame the graph the FIRST time there is both a layout and a sized canvas. */
  fitOnce(): void;
}

/**
 * Drive a {@link GraphWorld} from a Preact component. `hidden` is the legend's
 * filter set — it is read by every frame and every pick, so it is latched onto
 * the world on each render rather than closed over by the mount effect.
 */
export function useGraphCanvas(hidden: ReadonlySet<GraphNodeStatus>): GraphCanvas {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [dragCursor, setDragCursor] = useState(false);

  const worldRef = useRef<GraphWorld | null>(null);
  if (worldRef.current === null) worldRef.current = new GraphWorld();
  const world = worldRef.current;
  world.hidden = hidden;

  // Filled by the mount effect. The exported callbacks below dispatch through
  // these refs, so their identity is stable for the whole mount and the
  // component's data effects can depend on them without re-running.
  const redrawImpl = useRef<() => void>(() => {});
  const fitImpl = useRef<(animate: boolean) => void>(() => {});
  const repickImpl = useRef<() => void>(() => {});
  const fitOnceImpl = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
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

    // The canvas honors the same gate as every DOM animation (lib/motion.ts):
    // when reduced, entrances/rings draw at end state and the camera snaps.
    // Tracked live so an OS-level toggle takes effect without a remount.
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    world.reduced = motionQuery.matches;

    // --- The rAF gate -------------------------------------------------------
    const redraw = (): void => {
      if (world.raf !== 0) return; // a frame is already pending
      world.raf = requestAnimationFrame(() => {
        world.raf = 0;
        if (world.draw(ctx)) redraw(); // re-arm ONLY while something animates
      });
    };

    const fit = (animate: boolean): void => {
      if (world.fit(animate)) redraw();
    };

    /** Hover pick at the last pointer position; updates the tooltip state. */
    const repick = (): void => {
      const pointer = world.pointer;
      if (!world.snapshot || !world.layout || !pointer || world.dragging) {
        if (world.setHover(null)) redraw();
        setTip(null);
        return;
      }
      const hit = world.pick(pointer.sx, pointer.sy);
      if (world.setHover(hit)) redraw();
      setTip(hit === null ? null : world.tipFor(hit, pointer));
    };

    // --- Size tracking ------------------------------------------------------
    const fitOnce = (): void => {
      if (world.fitted || world.layout === null || canvas.width <= 1) return;
      world.fitted = true;
      fit(false);
    };

    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(host.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(host.clientHeight * dpr));
      world.setViewport(canvas.width / dpr, canvas.height / dpr, dpr);
      fitOnce();
      redraw();
    };

    redrawImpl.current = redraw;
    fitImpl.current = fit;
    repickImpl.current = repick;
    fitOnceImpl.current = fitOnce;

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // The ResizeObserver never fires when the window moves to a display with a
    // different scale factor (the CSS box is unchanged), which left a stale
    // backing store — blurry dots and offset hit-testing. Watch the dpr itself
    // via a resolution query, re-registering for each new ratio.
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      resize();
      watchDpr();
    };
    const watchDpr = (): void => {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    };
    watchDpr();

    const onMotionChange = (): void => {
      world.reduced = motionQuery.matches;
      redraw();
    };
    motionQuery.addEventListener('change', onMotionChange);

    // --- Interaction --------------------------------------------------------
    const zoom = (factor: number, sx: number, sy: number, animated: boolean): void => {
      world.zoomAt(factor, sx, sy, animated);
      redraw();
      if (!animated) repick(); // the wheel keeps the tooltip on the dot under it
    };
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      world.beginDrag(e.offsetX, e.offsetY);
      setDragCursor(true);
      setTip(null);
    };
    const onPointerMove = (e: PointerEvent): void => {
      if (world.dragTo(e.offsetX, e.offsetY)) redraw();
      else repick();
    };
    const onPointerUp = (e: PointerEvent): void => {
      const down = world.endDrag();
      setDragCursor(false);
      // A press that never became a drag is a CLICK — on a hub, frame it.
      if (down && Math.hypot(e.offsetX - down.sx, e.offsetY - down.sy) < CLICK_SLOP_PX) {
        repick();
        const hover = world.hover;
        if (hover?.kind === 'hub' && world.fitCluster(hover.index)) redraw();
      }
    };
    const onPointerCancel = (): void => {
      world.endDrag();
      setDragCursor(false);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * WHEEL_ZOOM), e.offsetX, e.offsetY, false);
    };
    const onDblClick = (e: MouseEvent): void => zoom(DBLCLICK_ZOOM, e.offsetX, e.offsetY, true);
    const onLeave = (): void => {
      world.pointer = null;
      repick();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDprChange);
      motionQuery.removeEventListener('change', onMotionChange);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      if (world.raf !== 0) cancelAnimationFrame(world.raf);
      world.raf = 0;
    };
  }, [world]);

  const redraw = useCallback((): void => redrawImpl.current(), []);
  const fit = useCallback((animate: boolean): void => fitImpl.current(animate), []);
  const repick = useCallback((): void => repickImpl.current(), []);
  const fitOnce = useCallback((): void => fitOnceImpl.current(), []);

  return { hostRef, canvasRef, world, tip, dragCursor, redraw, fit, repick, fitOnce };
}
