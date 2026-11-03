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

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';

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
export const RESERVOIR = SURFACE_BOUNDS.meterReservoir;

/** The persisted form of the reservoirs (`meta.surface_meter`). */
export interface MeterDump {
  v: 1;
  samples: Partial<Record<SurfaceMetric, number[]>>;
}

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

  /** The reservoirs as they stand, for `meta.surface_meter`. */
  dump(): MeterDump {
    const samples: MeterDump['samples'] = {};
    for (const [metric, bucket] of this.samples) samples[metric] = [...bucket];
    return { v: 1, samples };
  }

  /**
   * Restore persisted reservoirs (a restart starts warm). Anything malformed restores nothing and
   * answers false: the meter stays cold, never zero-filled; the caller says so in its log.
   */
  restore(raw: unknown): boolean {
    if (typeof raw !== 'object' || raw === null || (raw as { v?: unknown }).v !== 1) return false;
    const samples = (raw as { samples?: unknown }).samples;
    if (typeof samples !== 'object' || samples === null) return false;
    const next = new Map<SurfaceMetric, number[]>();
    for (const metric of SURFACE_METRICS) {
      const bucket = (samples as Record<string, unknown>)[metric];
      if (bucket === undefined) continue;
      if (!Array.isArray(bucket) || !bucket.every((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0)) {
        return false;
      }
      next.set(metric, (bucket as number[]).slice(-RESERVOIR));
    }
    this.samples.clear();
    for (const [metric, bucket] of next) this.samples.set(metric, bucket);
    return true;
  }
}

/**
 * The process-wide meter. The production surface sink persists its reservoirs
 * to `meta.surface_meter` on each flush and restores them when a graph builds.
 */
export const SURFACE_METER = new SurfaceMeter();
