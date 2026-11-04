import { Fragment, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { smoothPath } from '@/renderer/charts/catmull-rom';
import { shortDate } from '@/renderer/lib/format';
import {
  accumulateFrame,
  EASE,
  easeInOutCubic,
  GROWTH_REVEAL_DELAY_MS,
  GROWTH_REVEAL_DUR_MS,
  GROWTH_REVEAL_FADE_MS,
  prefersReducedMotion,
} from '@/renderer/lib/motion';
import type { NetGrowthPoint } from '@/types';

const X0 = 8;
const X1 = 362;
const Y0 = 104;
const Y1 = 12;

export interface GrowthChartProps {
  points: NetGrowthPoint[];
  /**
   * Dataset tag from the caller (the window selection these points answer).
   * Joins the first day + point count as the reveal's identity: the draw-in
   * replays only when the identity changes; same-identity live ticks update
   * the geometry in place at the current progress.
   */
  revealKey?: string;
  /**
   * When the measurement baseline began (ms), if ever — distinguishes a
   * measured-but-flat window from genuinely absent data in the empty state.
   */
  baselineAt?: number | null;
}

/** Mutable reveal-animation state, held across renders and rAF frames. */
interface RevealState {
  /** Dataset identity the running reveal belongs to. */
  identity: string;
  /** The realized path's measured length for the CURRENT geometry. */
  len: number;
  /** Capped-accumulated elapsed ms since the reveal armed (incl. the hold). */
  elapsed: number;
  /** Current eased progress in [0, 1]. */
  e: number;
  /** True once the post-hold opacity fade has been armed. */
  faded: boolean;
  /** True once the reveal reached the endpoint (or reduced motion skipped it). */
  done: boolean;
}

/**
 * The net-follower-growth trendline. Smooth Catmull-Rom line that draws in with a
 * leading dot riding the tip and the fill revealing underneath (clip grows with
 * the tip). Empty until the store has at least two days of own-follower data.
 */
export function GrowthChart({
  points,
  revealKey,
  baselineAt,
}: GrowthChartProps): JSX.Element {
  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const anim = useRef<RevealState | null>(null);
  const endPtRef = useRef<[number, number]>([X1, Y0]);

  const hasData = points.length >= 2 && points.some((p) => p.cumulativeNet !== 0);
  // A window the store measured that simply recorded zero net movement is NOT
  // absent data — misattributing it as "awaiting" would deny a real reading.
  const measuredFlat = points.length >= 2 && !hasData && baselineAt != null;
  const n = points.length;
  const totalSpan = Math.max(1, n - 1);
  const xAt = (dayIdx: number): number => X0 + (X1 - X0) * (dayIdx / totalSpan);

  // Include losses so a net-negative series remains inside the chart.
  const vmax = Math.max(1, ...points.map((p) => p.cumulativeNet));
  const vmin = Math.min(0, ...points.map((p) => p.cumulativeNet));
  const span = vmax - vmin;
  const yOf = (v: number): number => Y0 - (Y0 - Y1) * ((v - vmin) / span);
  const yZero = yOf(0);
  const coords: [number, number][] = points.map((p, i) => [
    xAt(points.length > 1 ? i : 0),
    yOf(p.cumulativeNet),
  ]);
  const lineD = hasData ? smoothPath(coords) : '';
  const endPt: [number, number] = coords.length ? coords[coords.length - 1] : [X1, yZero];
  // The area fills between the line and the ZERO baseline (not the frame
  // floor), closing at the measured endpoint.
  const areaD = hasData ? `${lineD}L${endPt[0].toFixed(1)},${yZero} L${X0},${yZero} Z` : '';
  const signed = (v: number): string => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));
  // Announce the trend's CURRENT value, signed — a churn-heavy net-negative
  // series must not read as growth.
  const latestNet = points.length ? points[points.length - 1].cumulativeNet : 0;

  // The reveal's dataset identity: replay only when the SELECTION or the
  // series' span genuinely changes — never on an in-place value tick.
  const identity = `${revealKey ?? ''}|${points.length ? points[0].dayStartMs : 0}|${points.length}`;

  // Everything below reads refs only, so the rAF loop's closure stays valid
  // across re-renders and in-place geometry updates.
  const place = (e: number): void => {
    const line = lineRef.current;
    const dot = dotRef.current;
    const clip = clipRef.current;
    const st = anim.current;
    if (!line || !dot || !clip || !st) return;
    line.style.strokeDashoffset = String(st.len * (1 - e));
    const tip =
      e >= 1
        ? { x: endPtRef.current[0], y: endPtRef.current[1] }
        : line.getPointAtLength(st.len * e);
    dot.setAttribute('cx', tip.x.toFixed(1));
    dot.setAttribute('cy', tip.y.toFixed(1));
    clip.setAttribute('width', (e >= 1 ? X1 + 2 : tip.x + 1).toFixed(1));
  };

  // Arm the ~200ms opacity fade for the hold's end. Listing ONLY opacity keeps
  // stroke-dashoffset untransitioned — the dash must track the rAF loop raw.
  const fadeIn = (): void => {
    for (const el of [lineRef.current, dotRef.current, areaRef.current]) {
      if (!el) continue;
      el.style.transition = `opacity ${GROWTH_REVEAL_FADE_MS}ms ${EASE}`;
      el.style.opacity = '1';
    }
  };

  // Pre-paint init (useLayoutEffect): Preact flushes useEffect AFTER paint, so
  // hiding/measuring there let the finished line flash for a frame before the
  // dash armed. All hide/measure/place work happens here; only the rAF driver
  // lives in the post-paint effect below.
  useLayoutEffect(() => {
    if (!hasData) {
      anim.current = null;
      return;
    }
    const line = lineRef.current;
    const dot = dotRef.current;
    const clip = clipRef.current;
    const area = areaRef.current;
    if (!line || !dot || !clip || !area) return;
    endPtRef.current = endPt;
    const len = line.getTotalLength();
    const prev = anim.current;
    if (prev !== null && prev.identity === identity) {
      // Same dataset, new values (a live tick): re-arm the dash for the new
      // geometry and preserve the current progress — never replay the reveal.
      prev.len = len;
      line.style.strokeDasharray = String(len);
      if (prev.faded) {
        line.style.opacity = '1';
        dot.style.opacity = '1';
        area.style.opacity = '1';
      }
      place(prev.e);
      return;
    }
    // New dataset: reset, and hide everything before this frame paints.
    const st: RevealState = { identity, len, elapsed: 0, e: 0, faded: false, done: false };
    anim.current = st;
    line.style.strokeDasharray = String(len);
    line.style.transition = 'none';
    dot.style.transition = 'none';
    area.style.transition = 'none';
    if (prefersReducedMotion()) {
      st.e = 1;
      st.faded = true;
      st.done = true;
      line.style.opacity = '1';
      dot.style.opacity = '1';
      area.style.opacity = '1';
      place(1);
      return;
    }
    line.style.opacity = '0';
    dot.style.opacity = '0';
    area.style.opacity = '0';
    place(0);
  }, [identity, lineD, hasData]);

  // Post-paint driver. Elapsed time accumulates through capped per-frame
  // deltas (accumulateFrame), so a main-thread stall slows the draw instead of
  // materializing the skipped span in one frame — or finishing inside the
  // stall. Keyed on identity, NOT lineD: in-place ticks never restart it.
  useEffect(() => {
    const st = anim.current;
    if (!hasData || st === null || st.identity !== identity || st.done) return;
    let lastTs: number | null = null;
    let raf = 0;
    const frame = (ts: number): void => {
      const s = anim.current;
      if (s === null || s.done) return;
      s.elapsed = accumulateFrame(s.elapsed, lastTs, ts);
      lastTs = ts;
      if (s.elapsed < GROWTH_REVEAL_DELAY_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (!s.faded) {
        s.faded = true;
        fadeIn();
      }
      const p = Math.min(1, (s.elapsed - GROWTH_REVEAL_DELAY_MS) / GROWTH_REVEAL_DUR_MS);
      s.e = easeInOutCubic(p);
      place(s.e);
      if (p < 1) raf = requestAnimationFrame(frame);
      else s.done = true;
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [identity, hasData]);

  return (
    <div>
      <svg
        class="growth-svg"
        viewBox="0 0 400 118"
        aria-label={`Cumulative net follower growth, ${signed(latestNet)}`}
      >
        <defs>
          <linearGradient id="growthGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(201,204,209,.18)" />
            <stop offset="100%" stop-color="rgba(201,204,209,0)" />
          </linearGradient>
          <clipPath id="growthClip">
            <rect ref={clipRef} x="0" y="0" width="0" height="118" />
          </clipPath>
        </defs>
        <line class="growth-grid dash" x1="8" y1="12" x2="362" y2="12" />
        <line class="growth-grid dash" x1="8" y1="58" x2="362" y2="58" />
        <line class="growth-grid" x1="8" y1="104" x2="362" y2="104" />
        {vmin < 0 ? (
          <line class="growth-grid" x1="8" y1={yZero} x2="362" y2={yZero} />
        ) : null}
        <text class="growth-ylab" x="398" y="15" text-anchor="end">
          {signed(vmax)}
        </text>
        <text class="growth-ylab" x="398" y="61" text-anchor="end">
          {signed((vmax + vmin) / 2)}
        </text>
        <text class="growth-ylab" x="398" y="107" text-anchor="end">
          {signed(vmin)}
        </text>
        {hasData ? (
          <Fragment>
            <path class="growth-area" ref={areaRef} clip-path="url(#growthClip)" d={areaD} />
            <path class="growth-line" ref={lineRef} d={lineD} />
            <circle class="growth-dot" ref={dotRef} r="3" />
          </Fragment>
        ) : (
          <text class="growth-ylab" x="185" y="60" text-anchor="middle">
            {measuredFlat ? 'No change in this range' : 'No follower history yet'}
          </text>
        )}
      </svg>
      <div class="growth-x num">
        <span>{points.length ? shortDate(points[0].dayStartMs) : '—'}</span>
        <span>{points.length ? shortDate(points[points.length - 1].dayStartMs) : '—'}</span>
      </div>
    </div>
  );
}
