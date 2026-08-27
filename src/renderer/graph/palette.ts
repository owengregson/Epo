/**
 * Status palette for the Graph view's canvas.
 *
 * Colors live in the console's graphite family (styles/tokens.css): muted,
 * desaturated hues on the dark ground, with the lifecycle statuses carrying
 * the recognizable accents — brass for waiting (--warn), green for held
 * (--ok), steel for queued (--live), the danger family for abandoned. They
 * are expressed as HSL so the two TIMED statuses can ramp SATURATION with
 * timer progress: a fresh timer draws washed-out and the color reaches full
 * saturation as the deadline nears. Progress is quantized into a small number
 * of ramp steps so the canvas can batch nodes by precomputed fill style
 * (per-node color strings would wreck batching at tens of thousands of dots).
 */
import { GRAPH_NODE_STATUSES, type GraphNodeStatus } from '@/types';

export interface StatusColor {
  h: number;
  s: number;
  l: number;
  /** True for statuses whose saturation ramps with timer progress. */
  timed: boolean;
}

export const STATUS_COLORS: Record<GraphNodeStatus, StatusColor> = {
  known: { h: 240, s: 5, l: 40, timed: false }, // the graphite crowd
  queued: { h: 214, s: 20, l: 74, timed: false }, // steel (--live family)
  waiting: { h: 41, s: 58, l: 63, timed: true }, // brass (--warn)
  held: { h: 147, s: 35, l: 56, timed: true }, // green (--ok)
  unfollow_queued: { h: 24, s: 55, l: 60, timed: false }, // ember, brass→danger
  unfollowed: { h: 240, s: 6, l: 27, timed: false }, // spent graphite
  abandoned: { h: 0, s: 32, l: 44, timed: false }, // dried danger
  external: { h: 270, s: 22, l: 63, timed: false }, // hands-off violet
  follows_you: { h: 205, s: 34, l: 63, timed: false }, // steel blue
  you_follow: { h: 226, s: 26, l: 67, timed: false }, // indigo steel
  mutual: { h: 160, s: 42, l: 62, timed: false }, // bright green-teal
};

/** Sidebar legend labels, in {@link GRAPH_NODE_STATUSES} order. */
export const LEGEND_LABELS: Record<GraphNodeStatus, string> = {
  known: 'Known',
  queued: 'Queued to follow',
  waiting: 'Waiting for follow-back',
  held: 'Followed back · holding',
  unfollow_queued: 'Queued to unfollow',
  unfollowed: 'Unfollowed',
  abandoned: 'Abandoned',
  external: 'External · hands off',
  follows_you: 'Follows you',
  you_follow: 'You follow',
  mutual: 'Mutual',
};

/** Saturation ramp resolution (progress buckets per timed status). */
export const RAMP_STEPS = 8;
/** A fresh timer keeps this fraction of the status's full saturation. */
const RAMP_FLOOR = 0.25;

/**
 * Bucket id for one node: `statusIdx * RAMP_STEPS + step`. Untimed statuses
 * always use step 0; timed ones map progress 0..1 onto the ramp.
 */
export function bucketOf(statusIdx: number, progress: number): number {
  const status = GRAPH_NODE_STATUSES[statusIdx] as GraphNodeStatus;
  if (!STATUS_COLORS[status].timed || progress < 0) return statusIdx * RAMP_STEPS;
  const step = Math.min(RAMP_STEPS - 1, Math.floor(progress * RAMP_STEPS));
  return statusIdx * RAMP_STEPS + step;
}

/** Every bucket's CSS color, precomputed once (index = bucket id). */
export const BUCKET_COLORS: readonly string[] = GRAPH_NODE_STATUSES.flatMap((status) => {
  const c = STATUS_COLORS[status];
  return Array.from({ length: RAMP_STEPS }, (_, step) => {
    if (!c.timed) return `hsl(${c.h} ${c.s}% ${c.l}%)`;
    // Mid-of-bucket progress drives the ramp so step 0 is visibly washed.
    const p = (step + 0.5) / RAMP_STEPS;
    const s = c.s * (RAMP_FLOOR + (1 - RAMP_FLOOR) * p);
    return `hsl(${c.h} ${s.toFixed(1)}% ${c.l}%)`;
  });
});

/** The legend swatch color for a status (full saturation). */
export function legendColor(status: GraphNodeStatus): string {
  const c = STATUS_COLORS[status];
  return `hsl(${c.h} ${c.s}% ${c.l}%)`;
}

/** The washed (progress ≈ 0) end of a timed status's ramp, for legend strips. */
export function legendColorWashed(status: GraphNodeStatus): string {
  const c = STATUS_COLORS[status];
  return `hsl(${c.h} ${(c.s * RAMP_FLOOR).toFixed(1)}% ${c.l}%)`;
}
