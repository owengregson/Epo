/**
 * The follow-back curve (spec §6.5): a small drawing of the six ordered points and one input per point.
 * Main keeps the points ordered and inside the safe range; the drawing is the curve the view holds.
 */
import type { JSX } from 'preact';
import type { RatioCurve } from '@/shared/settings-model';
import type { ParamView } from '@/shared/settings-view';
import { ROW_COPY } from '../copy/advanced';
import { NumberControl } from './ParamControl';

const POINTS = ['hardLow', 'bandLow', 'peakLow', 'peakHigh', 'bandHigh', 'hardHigh'] as const satisfies readonly (keyof RatioCurve)[];
/** The drawing's box, in its own units. */
const W = 240;
const H = 56;
/** Score at each point: nothing outside the curve, the band-edge score at its band, full on its peak. */
const scores = (edge: number): readonly number[] => [0, edge, 1, 1, edge, 0];

function Drawing({ curve, edge }: { curve: RatioCurve; edge: number }): JSX.Element {
  const score = scores(edge);
  const xs = POINTS.map((k) => Math.log10(Math.max(curve[k], Number.EPSILON)));
  const lo = Math.min(...xs);
  const span = Math.max(Number.EPSILON, Math.max(...xs) - lo);
  const pts = xs.map((x, i) => `${((x - lo) / span) * W},${H - (score[i] ?? 0) * (H - 4) - 2}`).join(' ');
  return (
    <svg class="set-curve__svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ROW_COPY.curveLabel}>
      <polyline points={pts} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
    </svg>
  );
}

export function CurveEditor({ p, value, edge, label, onCommit }: {
  p: ParamView; value: RatioCurve; edge: number; label: string; onCommit(v: RatioCurve): void;
}): JSX.Element {
  const b = p.bounds.kind === 'bool' ? { min: 0, max: 0 } : p.bounds;
  return (
    <div class="set-curve">
      <Drawing curve={value} edge={edge} />
      <div class="set-curve__points">
        {POINTS.map((k, i) => (
          <span key={k} class="set-curve__point">
            <small>{ROW_COPY.curvePoints[i]}</small>
            <NumberControl
              p={p}
              value={value[k]}
              label={`${label}: ${ROW_COPY.curvePoints[i]}`}
              min={i === 0 ? b.min : value[POINTS[i - 1] as keyof RatioCurve]}
              max={i === POINTS.length - 1 ? b.max : value[POINTS[i + 1] as keyof RatioCurve]}
              onCommit={(v) => onCommit({ ...value, [k]: v })}
            />
          </span>
        ))}
      </div>
    </div>
  );
}
