/** @jsx h */
import { h, Fragment } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { NetGrowthPoint } from '@/types';
import { smoothPath } from './catmull-rom';
import { shortDate } from '../lib/format';
import {
  GROWTH_REVEAL_DELAY_MS,
  GROWTH_REVEAL_DUR_MS,
  easeOutCubic,
  prefersReducedMotion,
} from '../lib/motion';

const X0 = 8;
const X1 = 362;
const Y0 = 104;
const Y1 = 12;

export interface GrowthChartProps {
  points: NetGrowthPoint[];
}

/**
 * The net-follower-growth trendline. Smooth Catmull-Rom line that draws in with a
 * leading dot riding the tip and the fill revealing underneath (clip grows with
 * the tip). Empty until the store has at least two days of own-follower data.
 */
export function GrowthChart({ points }: GrowthChartProps): h.JSX.Element {
  const lineRef = useRef<SVGPathElement>(null);
  const areaRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const clipRef = useRef<SVGRectElement>(null);

  const hasData = points.length >= 2 && points.some((p) => p.cumulativeNet !== 0);
  // Domain covers LOSSES too: a churn-heavy day genuinely produces a negative
  // cumulative net, and a gain-only [0, vmax] scale used to fling the line far
  // below the viewBox (the chart just disappeared).
  const vmax = Math.max(1, ...points.map((p) => p.cumulativeNet));
  const vmin = Math.min(0, ...points.map((p) => p.cumulativeNet));
  const span = vmax - vmin;
  const yOf = (v: number): number => Y0 - (Y0 - Y1) * ((v - vmin) / span);
  const yZero = yOf(0);
  const coords: [number, number][] = points.map((p, i) => [
    X0 + (X1 - X0) * (points.length > 1 ? i / (points.length - 1) : 0),
    yOf(p.cumulativeNet),
  ]);
  const lineD = hasData ? smoothPath(coords) : '';
  // The area fills between the line and the ZERO baseline (not the frame floor).
  const areaD = hasData ? `${lineD}L${X1},${yZero} L${X0},${yZero} Z` : '';
  const endPt: [number, number] = coords.length ? coords[coords.length - 1] : [X1, yZero];
  const signed = (v: number): string => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));

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
        aria-label={`Cumulative net follower growth, up ${Math.round(vmax)}`}
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
        <span>{points.length ? shortDate(points[points.length - 1].dayStartMs) : '—'}</span>
      </div>
    </div>
  );
}
