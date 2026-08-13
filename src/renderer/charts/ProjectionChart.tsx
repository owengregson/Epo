/** @jsx h */
import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { ProjectionResult } from './growth-model';
import { clamp, commas } from '../lib/format';
import { prefersReducedMotion } from '../lib/motion';

const X0 = 8;
const X1 = 348;
const Y0 = 104;
const Y1 = 12;

export interface ProjectionChartProps {
  result: ProjectionResult;
}

/**
 * The three-scenario projected-growth chart. Recomputes live from settings; draws
 * its curves in the first time it becomes visible (IntersectionObserver, since it
 * lives on the initially-hidden Settings view), then updates instantly on edits.
 */
export function ProjectionChart({ result }: ProjectionChartProps): h.JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const pathRefs = [
    useRef<SVGPathElement>(null),
    useRef<SVGPathElement>(null),
    useRef<SVGPathElement>(null),
  ];
  const drawn = useRef(false);

  const { scenarios, vmax } = result;

  const paths = scenarios.map((sc) => {
    let d = '';
    sc.pts.forEach((v, j) => {
      const x = X0 + (X1 - X0) * (j / (sc.pts.length - 1));
      const y = clamp(Y0 - (Y0 - Y1) * (v / vmax), Y1, Y0);
      d += `${j ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return d;
  });

  // Endpoint label positions: separate ≥11px (optimistic highest), then pull the
  // stack back up if the bottom label would leave the plot.
  const endY = scenarios.map((sc) => Y0 - (Y0 - Y1) * (sc.end / vmax) + 3);
  endY[1] = Math.max(endY[1], endY[2] + 11);
  endY[0] = Math.max(endY[0], endY[1] + 11);
  if (endY[0] > 100) {
    endY[0] = 100;
    endY[1] = Math.min(endY[1], endY[0] - 11);
    endY[2] = Math.min(endY[2], endY[1] - 11);
  }
  const labels = scenarios.map((sc) => `+${commas(Math.round(sc.end))}`);

  // First-visibility draw-in.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    if (prefersReducedMotion()) {
      drawn.current = true;
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || drawn.current) continue;
        drawn.current = true;
        const els = pathRefs.map((r) => r.current).filter(Boolean) as SVGPathElement[];
        els.forEach((p) => {
          const len = p.getTotalLength();
          p.style.strokeDasharray = String(len);
          p.style.strokeDashoffset = String(len);
        });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            els.forEach((p) => {
              p.style.strokeDashoffset = '0';
            });
            // Once drawn, drop the dash so later edits update the paths freely.
            window.setTimeout(() => {
              els.forEach((p) => {
                p.style.strokeDasharray = '';
                p.style.strokeDashoffset = '';
              });
            }, 1300);
          }),
        );
        io.disconnect();
      }
    });
    io.observe(svg);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <svg
      class="proj-svg"
      viewBox="0 0 400 122"
      ref={svgRef}
      aria-label="Projected cumulative net follower growth over the next 30 days, across cautious, expected and optimistic yield scenarios"
    >
      <line class="growth-grid dash" x1="8" y1="12" x2="348" y2="12" />
      <line class="growth-grid dash" x1="8" y1="58" x2="348" y2="58" />
      <line class="growth-grid" x1="8" y1="104" x2="348" y2="104" />
      <text class="growth-ylab" x="354" y="107">
        0
      </text>
      <path class="proj-line bad" ref={pathRefs[0]} d={paths[0]} />
      <path class="proj-line avg" ref={pathRefs[1]} d={paths[1]} />
      <path class="proj-line good" ref={pathRefs[2]} d={paths[2]} />
      <text class="proj-end bad" x="354" y={endY[0].toFixed(1)}>
        {labels[0]}
      </text>
      <text class="proj-end avg" x="354" y={endY[1].toFixed(1)}>
        {labels[1]}
      </text>
      <text class="proj-end good" x="354" y={endY[2].toFixed(1)}>
        {labels[2]}
      </text>
    </svg>
  );
}
