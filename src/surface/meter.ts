/**
 * SurfaceMeter — what the adapter's five timing constants actually ARE.
 *
 * `POLL_TIMEOUT_MS: 8_000`, `MUTATION_RESPONSE_TIMEOUT_MS: 12_000`,
 * `FETCH_ABORT_MS`, `GET_BODY_TIMEOUT_MS` and the scroll settle are hand-set
 * numbers standing in for percentiles nobody measured. This measures them, at
 * the five seams that already exist, so wave B's derivations have real inputs.
 *
 * Wave A MEASURES ONLY. No timeout is derived from a reservoir here — the
 * design's guard rails (≤2× per recompute, freeze under recovery, priors are
 * today's constants) land with the derivation, and a meter that silently
 * retuned the app before those exist would be the exact failure mode
 * (latency spike → longer timeout → slower detection → more spikes) the guard
 * rails are for.
 *
 * Two invariants make the numbers honest:
 *
 *  - **Successful samples only.** A failed hydration measures the timeout, not
 *    the page: feeding it back would make every timeout grow into itself.
 *  - **A bounded reservoir.** 128 samples per metric, newest-wins; percentiles
 *    are computed on demand (sorting 128 numbers is free) so nothing is
 *    maintained incrementally and nothing drifts.
 */

/** The quantities the adapter can measure about itself. */
export type SurfaceMetric =
  /** `goto` resolve → first successful control locate. */
  | 'hydration'
  /** Press dispatched → matching mutation response observed. */
  | 'mutation-arrival'
  /** In-page list fetch issued → envelope resolved. */
  | 'list-page'
  /** CDP `Network.getResponseBody` round trip. */
  | 'body-read'
  /** Wheel burst end → new rows in the list. */
  | 'scroll-settle';

export const SURFACE_METRICS: readonly SurfaceMetric[] = [
  'hydration',
  'mutation-arrival',
  'list-page',
  'body-read',
  'scroll-settle',
];

/** How many samples one metric holds. */
export const RESERVOIR = 128;

/** One metric's summary. `p50`/`p95` are `null` until any sample exists. */
export interface MetricSummary {
  metric: SurfaceMetric;
  n: number;
  p50: number | null;
  p95: number | null;
}

export type MeterSnapshot = Record<SurfaceMetric, MetricSummary>;

const percentile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 1) return sorted[0] as number;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] as number;
};

export class SurfaceMeter {
  private readonly samples = new Map<SurfaceMetric, number[]>();

  /**
   * Record one SUCCESSFUL observation. A non-finite or non-positive duration is
   * dropped rather than clamped — a clock going backwards is not a measurement.
   */
  record(metric: SurfaceMetric, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let bucket = this.samples.get(metric);
    if (bucket === undefined) {
      bucket = [];
      this.samples.set(metric, bucket);
    }
    bucket.push(ms);
    if (bucket.length > RESERVOIR) bucket.splice(0, bucket.length - RESERVOIR);
  }

  /**
   * Time `run` and record it only if it RESOLVES. A rejection (a stale control,
   * an aborted wait, a tab stall) is not a latency sample.
   */
  async time<T>(metric: SurfaceMetric, now: () => number, run: () => Promise<T>): Promise<T> {
    const started = now();
    const value = await run();
    this.record(metric, now() - started);
    return value;
  }

  summary(metric: SurfaceMetric): MetricSummary {
    const bucket = this.samples.get(metric) ?? [];
    if (bucket.length === 0) return { metric, n: 0, p50: null, p95: null };
    const sorted = [...bucket].sort((a, b) => a - b);
    return {
      metric,
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
    };
  }

  snapshot(): MeterSnapshot {
    const out = {} as MeterSnapshot;
    for (const metric of SURFACE_METRICS) out[metric] = this.summary(metric);
    return out;
  }

  reset(): void {
    this.samples.clear();
  }
}

/**
 * The process-wide meter. In-memory this wave; persisting the compact
 * `{n, p50, p95}` triple per metric into store `meta` (so a restart starts warm
 * instead of cold) is a store seam, not an adapter one.
 */
export const SURFACE_METER = new SurfaceMeter();
