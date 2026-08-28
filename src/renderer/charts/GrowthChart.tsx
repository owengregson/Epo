/** @jsx h */
import { Fragment, h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { NetGrowthPoint } from '@/types';
import { shortDate } from '../lib/format';
import {
  easeOutCubic,
  GROWTH_REVEAL_DELAY_MS,
  GROWTH_REVEAL_DUR_MS,
  prefersReducedMotion,
} from '../lib/motion';
import { smoothPath } from './catmull-rom';
import type { GrowthOverlay } from './growth-overlay';

const X0 = 8;
const X1 = 362;
const Y0 = 104;
const Y1 = 12;

export interface GrowthChartProps {
  points: NetGrowthPoint[];
  /**
   * Optional projection continuation: the model's three re-anchored scenario
   * paths, drawn PAST the realized endpoint as a subtle band (cautious→
   * optimistic) with a dashed expected line. Ignored until the realized series
   * carries data — a projection with nothing real under it belongs to the
   * Settings simulator, not here.
   */
  overlay?: GrowthOverlay | null;
}

/**
 * The net-follower-growth trendline. Smooth Catmull-Rom line that draws in with a
 * leading dot riding the tip and the fill revealing underneath (clip grows with
 * the tip). Empty until the store has at least two days of own-follower data.
 * With an overlay, the x-domain extends `horizonDays` past today and the
 * projection band continues from the realized endpoint.
 */
export function GrowthChart({ points, overlay }: GrowthChartProps): h.JSX.Element {
  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const clipRef = useRef<SVGRectElement>(null);

  const hasData = points.length >= 2 && points.some((p) => p.cumulativeNet !== 0);
  const proj = hasData && overlay ? overlay : null;
  const n = points.length;
  const horizon = proj ? proj.horizonDays : 0;
  // The x-domain spans realized days plus the projection horizon (in days).
  const totalSpan = Math.max(1, n - 1 + horizon);
  const xAt = (dayIdx: number): number => X0 + (X1 - X0) * (dayIdx / totalSpan);

  // Domain covers LOSSES too: a churn-heavy day genuinely produces a negative
  // cumulative net, and a gain-only [0, vmax] scale used to fling the line far
  // below the viewBox (the chart just disappeared). The projection's ceiling
  // (optimistic endpoint) joins the domain so the band always fits.
  const vmax = Math.max(
    1,
    ...points.map((p) => p.cumulativeNet),
    ...(proj ? [proj.optimistic[proj.optimistic.length - 1]] : []),
  );
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
  // floor), closing at the REALIZED endpoint — never under the projection.
  const areaD = hasData ? `${lineD}L${endPt[0].toFixed(1)},${yZero} L${X0},${yZero} Z` : '';
  const signed = (v: number): string => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));
  // Announce the trend's CURRENT value, signed — a churn-heavy net-negative
  // series must not read as growth.
  const latestNet = points.length ? points[points.length - 1].cumulativeNet : 0;

  // Projection geometry: band between cautious and optimistic, dashed expected
  // line — the same polygon construction as the README pipeline's band. All
  // three paths start exactly at the realized endpoint (re-anchored model).
  const xJ = xAt(Math.max(0, n - 1));
  const projPt = (t: number, v: number): string =>
    `${xAt(n - 1 + t).toFixed(1)},${yOf(v).toFixed(1)}`;
  const bandPts = proj
    ? [
        ...proj.cautious.map((v, t) => projPt(t, v)),
        ...proj.optimistic.map((v, t) => projPt(t, v)).reverse(),
      ].join(' ')
    : '';
  const expectedPts = proj ? proj.expected.map((v, t) => projPt(t, v)).join(' ') : '';

  useEffect(() => {
    if (!hasData) return;
    const line = lineRef.current;
    const dot = dotRef.current;
    const clip = clipRef.current;
    const area = areaRef.current;
    if (!line || !dot || !clip || !area) return;

    const len = line.getTotalLength();
    line.style.transition = 'none';
    line.style.strokeDasharray = String(len);
    dot.style.transition = 'none';
    area.style.transition = 'none';
    dot.style.opacity = '1';
    area.style.opacity = '1';

    const place = (frac: number): void => {
      const e = Math.min(1, Math.max(0, frac));
      line.style.strokeDashoffset = String(len * (1 - e));
      const tip = e >= 1 ? { x: endPt[0], y: endPt[1] } : line.getPointAtLength(len * e);
      dot.setAttribute('cx', tip.x.toFixed(1));
      dot.setAttribute('cy', tip.y.toFixed(1));
      clip.setAttribute('width', (e >= 1 ? X1 + 2 : tip.x + 1).toFixed(1));
    };

    if (prefersReducedMotion()) {
      place(1);
      return;
    }

    place(0);
    let start: number | null = null;
    let raf = 0;
    const frame = (ts: number): void => {
      if (start === null) start = ts;
      const p = (ts - start - GROWTH_REVEAL_DELAY_MS) / GROWTH_REVEAL_DUR_MS;
      place(p <= 0 ? 0 : easeOutCubic(Math.min(1, p)));
      if (p < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [lineD, hasData]);

  return (
    <div>
      <svg
        class="growth-svg"
        viewBox="0 0 400 118"
        aria-label={
          proj
            ? `Cumulative net follower growth, ${signed(latestNet)}, with a ${horizon}-day projection band continuing from today`
            : `Cumulative net follower growth, ${signed(latestNet)}`
        }
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
        <text class="growth-ylab" x="370" y="15">
          {signed(vmax)}
        </text>
        <text class="growth-ylab" x="370" y="61">
          {signed((vmax + vmin) / 2)}
        </text>
        <text class="growth-ylab" x="370" y="107">
          {signed(vmin)}
        </text>
        {proj ? (
          <Fragment>
            <line class="growth-grid dash" x1={xJ.toFixed(1)} y1={Y1} x2={xJ.toFixed(1)} y2={Y0} />
            <text class="growth-ylab" x={xJ.toFixed(1)} y="115" text-anchor="middle">
              today
            </text>
            <polygon class="growth-proj-band" points={bandPts} />
            <polyline class="growth-proj-line" points={expectedPts} />
          </Fragment>
        ) : null}
        {hasData ? (
          <Fragment>
            <path class="growth-area" ref={areaRef} clip-path="url(#growthClip)" d={areaD} />
            <path class="growth-line" ref={lineRef} d={lineD} />
            <circle class="growth-dot" ref={dotRef} r="3" />
          </Fragment>
        ) : (
          <text class="growth-ylab" x="185" y="60" text-anchor="middle">
            Awaiting follower data…
          </text>
        )}
      </svg>
      <div class="growth-x num">
        <span>{points.length ? shortDate(points[0].dayStartMs) : '—'}</span>
        <span>
          {proj
            ? `+${horizon}d projected`
            : points.length
              ? shortDate(points[points.length - 1].dayStartMs)
              : '—'}
        </span>
      </div>
    </div>
  );
}
