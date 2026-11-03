/**
 * Timing-noise layer — the fix for deterministic scheduling. Every operational
 * wait in the engines is classified into a {@link WaitClass}, and the non-exact
 * classes get their cadence de-synchronized here: daily boundaries wake a
 * restart-stable random offset PAST the configured o'clock (never before it),
 * watcher cadences stretch/shrink per run, retry backoffs draw log-normal
 * around their base, and local beats are a `pause.retry` draw around their base. Without
 * this, every default install woke at exactly `activeHoursStart:00:00.000`,
 * resumed daily-ceiling parks on the same o'clock instant, and swept
 * notifications on a bare hourly grid.
 *
 * Pure and dependency-free (no Node, no Electron), like `distributions.ts`.
 * The constants live in the NOISE group of `timing/config.ts`; the beat band and the
 * rest stride are tempo specs (`pause.retry`, `walk.rest-every`).
 */

import { fnv1a, mulberry32 } from '../kernel/rng';
import { referenceTempoSource, type TempoSource, tempoOrReference } from '../kernel/tempo';
import { NOISE } from './config';
import { clamp, logNormal, normal01 } from './distributions';
import type { DelayPolicy, Rng } from './primitives';
import { startOfLocalDay } from './units';

/**
 * How a wait's duration relates to the observable cadence it emits:
 *
 *  - 'daily-boundary':  a park ending at a configured local-clock boundary
 *                       (active-hours open, daily-cycle reset) — gets a
 *                       restart-stable, positive-only offset past the boundary.
 *  - 'watcher-cadence': a persisted due-by-timestamp interval (the follow-back
 *                       sweep) — each completed run redraws a bounded factor.
 *  - 'retry-backoff':   a park before retrying walled/blocked work — drawn
 *                       log-normal around its base, bounded.
 *  - 'local-beat':      a short internal beat (idle, transient backoff) —
 *                       drawn uniform inside a band around its base.
 *  - 'sub-cadence':     an intra-operation pacing element (scroll waits, rest
 *                       strides) — same band treatment as a local beat.
 *  - 'exact':           passes through untouched — the call site already draws
 *                       its own jitter (double-jittering is a bug).
 */
export type WaitClass =
  | 'daily-boundary'
  | 'watcher-cadence'
  | 'retry-backoff'
  | 'local-beat'
  | 'sub-cadence'
  | 'exact';

/**
 * The seeded PRNG (mulberry32) and key hash (FNV-1a) live in the kernel; seeded,
 * never Math.random, so a value derived from stable seed material (day key ⊕
 * wait key ⊕ install entropy) survives a mid-park restart (§3).
 */
export { fnv1a as hashSeedKey, mulberry32 };

/**
 * The seed key a daily-boundary jitter draw is stable UNDER: the LOCAL day the
 * boundary belongs to (the resume day — for a park that resumes tomorrow,
 * tomorrow's day) plus the wait key. A park armed at 23:50 and a restart that
 * re-arms it at 00:10 both target the same boundary instant, so both derive the
 * same key — and therefore the same jittered wake (§3, schedules are durable).
 * Different keys (active-hours vs daily-ceiling) draw independent offsets.
 */
export function boundarySeedKey(resumeAtMs: number, waitKey: string): string {
  return `${startOfLocalDay(resumeAtMs)}|${waitKey}`;
}

/**
 * Jitter a daily-boundary park: `baseMs` (the exact ms to the configured
 * boundary) plus a POSITIVE-ONLY offset in [1, DAILY_BOUNDARY_JITTER_MAX_MS] —
 * a wake never precedes the configured window, and never lands exactly ON the
 * boundary (the 1 ms floor covers the u≈0 edge). Seeded by
 * (seedKey, installEntropy), so the offset is stable within a day and across a
 * mid-park restart, but different per day, per key, and per install.
 */
export function jitterBoundary(baseMs: number, seedKey: string, installEntropy: number): number {
  const seed = (fnv1a(seedKey) ^ Math.imul(installEntropy >>> 0, 0x9e3779b1)) >>> 0;
  const u = mulberry32(seed)();
  return baseMs + Math.max(1, Math.round(u * NOISE.DAILY_BOUNDARY_JITTER_MAX_MS));
}

/** The beat band's source: the reference tempo, whatever the session (see {@link noisify}). */
const BEAT: TempoSource = referenceTempoSource();

/** A log-normal factor around 1, bounded by re-draw — `clamp` in factor space. */
function boundedFactor(rng: Rng, sigma: number, min: number, max: number): number {
  return clamp({ kind: 'logNormalFactor', sample: (r) => Math.exp(sigma * normal01(r)) }, min, max)
    .sample(rng);
}

/**
 * One watcher-cadence interval factor: log-normal around 1 (σ = CADENCE_SIGMA),
 * bounded to [CADENCE_MIN_FACTOR, CADENCE_MAX_FACTOR]. Drawn fresh at each
 * cadence `markRun` and persisted, so consecutive sweep intervals differ but a
 * restart mid-interval keeps the one already drawn.
 */
export function cadenceFactor(rng: Rng): number {
  return boundedFactor(rng, NOISE.CADENCE_SIGMA, NOISE.CADENCE_MIN_FACTOR, NOISE.CADENCE_MAX_FACTOR);
}

/**
 * The next list-walk long-rest stride: one `walk.rest-every` draw (whole pages) at the tempo in
 * force, redrawn after each rest — the breather stops landing after exactly every Nth page.
 */
export function nextRestStride(rng: Rng, tempo?: TempoSource): number {
  return tempoOrReference(tempo).policy('walk.rest-every').sample(rng);
}

/**
 * Wrap a wait's base duration in its class's noise. 'exact' passes through
 * unchanged; every other class returns a policy whose draws vary:
 *
 *  - 'retry-backoff'  → clamp(logNormal(base, BACKOFF_SIGMA), 0.5×, 2.0×)
 *  - 'local-beat' / 'sub-cadence' → the reference `pause.retry` band around base,
 *    uniform(base × 0.7, base × 1.45): the base already follows the plan, and a brisk
 *    session never shortens a failure beat (`beat.transient` is pace-up, spec §5.11)
 *  - 'watcher-cadence' → base × cadenceFactor
 *  - 'daily-boundary' → base + uniform(1, DAILY_BOUNDARY_JITTER_MAX_MS)
 *    (the UNSEEDED shape — callers needing restart stability use
 *    {@link jitterBoundary} with a {@link boundarySeedKey} instead)
 *
 * CRITICAL CONTRACT: the returned policy draws from the rng given HERE — its
 * `sample()` ignores the sampler's rng argument. Noise must never consume the
 * caller's seeded stream (the engines' existing rng draw order stays
 * byte-identical), so callers pass a DEDICATED noise rng and may hand the
 * policy to a DelayManager without perturbing its rng either.
 */
export function noisify(cls: WaitClass, base: DelayPolicy | number, rng: Rng): DelayPolicy | number {
  if (cls === 'exact') return base;
  const drawBase: () => number = typeof base === 'number' ? () => base : () => base.sample(rng);
  let draw: () => number;
  switch (cls) {
    case 'retry-backoff':
      draw = () => {
        const b = drawBase();
        return clamp(
          logNormal(b, NOISE.BACKOFF_SIGMA),
          Math.round(b * NOISE.BACKOFF_MIN_FACTOR),
          Math.round(b * NOISE.BACKOFF_MAX_FACTOR),
        ).sample(rng);
      };
      break;
    case 'local-beat':
    case 'sub-cadence':
      draw = () => BEAT.policy('pause.retry', { baseMs: drawBase() }).sample(rng);
      break;
    case 'watcher-cadence':
      draw = () => Math.round(drawBase() * cadenceFactor(rng));
      break;
    case 'daily-boundary':
      draw = () => drawBase() + Math.max(1, Math.round(rng() * NOISE.DAILY_BOUNDARY_JITTER_MAX_MS));
      break;
  }
  return { kind: `noise(${cls})`, sample: () => Math.max(0, draw()) };
}
