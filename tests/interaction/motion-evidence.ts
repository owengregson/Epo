import { movementPlan, type Point } from '@/interaction/motion-profile';

/** Reproducible motion-only probe, also used by the distribution regression. */
export const motionRng = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

export const separation = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const average = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = average(sorted);
  return {
    min: sorted[0],
    p10: sorted[Math.floor(sorted.length * 0.1)],
    median: sorted[Math.floor(sorted.length * 0.5)],
    p90: sorted[Math.floor(sorted.length * 0.9)],
    max: sorted[sorted.length - 1],
    cv: Math.sqrt(average(values.map((value) => (value - mean) ** 2))) / mean,
  };
}

export function motionEvidence(distancePx = 700, samples = 500) {
  const from = { x: 100, y: 300 };
  const to = { x: from.x + distancePx, y: from.y };
  const durations: number[] = [];
  const counts: number[] = [];
  const peakSpeeds: number[] = [];
  const lengthRatios: number[] = [];
  const tailRatios: number[] = [];
  const deviations: number[] = [];
  const paths = new Set<string>();
  const cadences = new Set<string>();
  let exactEndpoints = 0;
  let overshoots = 0;
  for (let seed = 0; seed < samples; seed++) {
    const plan = movementPlan(from, to, 40, motionRng(seed));
    const lengths = plan.points.slice(1).map((point, i) => separation(point, plan.points[i]));
    const speeds = lengths.map((length, i) => length * 1_000 / plan.delaysMs[i]);
    durations.push(plan.delaysMs.reduce((sum, value) => sum + value, 0));
    counts.push(plan.delaysMs.length);
    peakSpeeds.push(Math.max(...speeds));
    lengthRatios.push(lengths.reduce((sum, value) => sum + value, 0) / distancePx);
    deviations.push(Math.max(...plan.points.map((point) => Math.abs(point.y - from.y))));
    const middle = speeds.slice(Math.floor(speeds.length * 0.3), Math.ceil(speeds.length * 0.6));
    tailRatios.push(average(speeds.slice(-3)) / average(middle));
    paths.add(JSON.stringify(plan.points));
    cadences.add(plan.delaysMs.join(','));
    const end = plan.points[plan.points.length - 1];
    exactEndpoints += Number(end.x === to.x && end.y === to.y);
    overshoots += Number(plan.points.some((point) => point.x > to.x));
  }
  return {
    distancePx, samples, exactEndpoints, uniquePaths: paths.size,
    uniqueCadences: cadences.size, overshoots,
    durationMs: distribution(durations), eventCount: distribution(counts),
    peakSpeedPxPerSecond: distribution(peakSpeeds), pathLengthRatio: distribution(lengthRatios),
    tailToMidSpeedRatio: distribution(tailRatios), lateralDeviationPx: distribution(deviations),
  };
}
