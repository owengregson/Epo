/**
 * Timing-noise layer: every engine wait is classified into a {@link WaitClass}; retry backoffs draw
 * log-normal around their base and local beats a `pause.retry` draw around theirs, while the plan's
 * parks end exactly where it says (spec §5.16). Pure and dependency-free, like `distributions.ts`.
 */

import { mulberry32 } from '../kernel/rng';
import { referenceTempoSource, type TempoSource, tempoOrReference } from '../kernel/tempo';
import { NOISE } from './config';
import { clamp, logNormal } from './distributions';
import type { DelayPolicy, Rng } from './primitives';

/**
 * How a wait's duration relates to the observable cadence it emits:
 *
 *  - 'retry-backoff':   a park before retrying walled/blocked work — drawn
 *                       log-normal around its base, bounded.
 *  - 'local-beat':      a short internal beat (idle, transient backoff) —
 *                       drawn uniform inside a band around its base.
 *  - 'sub-cadence':     an intra-operation pacing element (scroll waits, rest
 *                       strides) — same band treatment as a local beat.
 *  - 'exact':           passes through untouched — the plan names the instant, or
 *                       the call site already draws its own spread.
 */
export type WaitClass = 'retry-backoff' | 'local-beat' | 'sub-cadence' | 'exact';

/** The seeded PRNG lives in the kernel; every stream is seeded, never Math.random. */
export { mulberry32 };

/** The beat band's source: the reference tempo, whatever the session (see {@link noisify}). */
const BEAT: TempoSource = referenceTempoSource();

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
  }
  return { kind: `noise(${cls})`, sample: () => Math.max(0, draw()) };
}
