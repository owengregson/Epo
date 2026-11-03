/**
 * The TempoSource port (ADR 0607, spec §5.11): every Instagram-facing wait,
 * dwell and gesture asks it rather than reading a registry constant. The
 * reference source reproduces today's values exactly; the plan swaps a
 * plan-backed source in at its wiring module, and no consumer changes.
 */

import { CAUTION, hourlyCap, NOISE, RHYTHM, SESSION } from '../derive';
import type { SessionTempo } from '../plan/types';
import { POLICY } from '../policy';
import { fnv1a, mulberry32 } from '../rng';
import { MS_PER_HOUR, MS_PER_SECOND } from '../units';
import type { TempoKey } from './keys';
import { deriveMotion, MOTION_REFERENCE, type MotionPolicy } from './motion';
import { drawResolved, locationOf, resolve, type TempoSite } from './resolve';
import { TEMPO_SPECS } from './specs';

/** A drawable policy, structurally a `DelayPolicy`: `sample(rng)` draws with the caller's rng, else the key's own stream. */
export interface TempoPolicy {
  readonly kind: string;
  sample(rng?: () => number): number;
}

export interface TempoSource {
  /** The tempo in force: the open session's, else the ambient day tempo (a pure read). */
  current(): SessionTempo;
  /** The key's location at the current tempo (a wait gate's base). */
  base(key: TempoKey): number;
  /** One draw from the key's own seeded stream. */
  draw(key: TempoKey, site?: TempoSite): number;
  /** The key's distribution at the current tempo; `site` carries a relative key's call-site base. */
  policy(key: TempoKey, site?: TempoSite): TempoPolicy;
  /** The motion policy, resolved once per gesture, and that gesture's stream. */
  gesture(): { readonly policy: MotionPolicy; readonly rng: () => number };
  /** False only for keys this overhaul adds, under the reference source (their sites stay off at identity). */
  enabled(key: TempoKey): boolean;
}

/** The balanced reference session at tempo 1: pace = motion = depth = 1, today's gap at τ = 1. */
export const REFERENCE_TEMPO: SessionTempo = {
  z: 0,
  pace: 1,
  motion: 1,
  depth: 1,
  gap: {
    medianMs: RHYTHM.sessions.gapMedianSeconds * MS_PER_SECOND,
    sigma: SESSION.GAP_SIGMA,
    floorMs: CAUTION.standard.floorSeconds * MS_PER_SECOND,
    capMs: SESSION.GAP_CAP_MS,
    hawkesAlpha: SESSION.HAWKES_ALPHA,
    hawkesTauMs: SESSION.HAWKES_TAU_MS,
    timeScale: 1,
    // The rate-neutral target at pace 1 (§5.10); τ stays 1 here: the reference never solves τ.
    targetMeanMs: (MS_PER_HOUR * POLICY.CEILING_HEADROOM) / hourlyCap('standard') / NOISE.BEAT_MIN_FACTOR,
  },
  mix: 'normal',
  probation: false,
};

export interface TempoSourceDeps {
  current(): SessionTempo;
  /** Seeds every key's own stream (mulberry32(fnv1a(key) ^ launchSeed)). */
  launchSeed?: number;
  /** A `tempo.<key>` Advanced override: a reference factor in [1, 3], applied before the session factor. */
  overrideFactor?(key: TempoKey): number;
  enabled?(key: TempoKey): boolean;
}

/** A TempoSource over any tempo provider; the plan-backed source and the test kit build on it. */
export function tempoSource(d: TempoSourceDeps): TempoSource {
  const streams = new Map<string, () => number>();
  const stream = (name: string): (() => number) => {
    let s = streams.get(name);
    if (s === undefined) {
      s = mulberry32((fnv1a(name) ^ (d.launchSeed ?? 0)) >>> 0);
      streams.set(name, s);
    }
    return s;
  };
  const at = (key: TempoKey, site?: TempoSite) => resolve(key, d.current(), d.overrideFactor?.(key) ?? 1, site);
  return {
    current: () => d.current(),
    base: (key) => locationOf(at(key)),
    draw: (key, site) => drawResolved(at(key, site), stream(key)),
    policy: (key, site) => {
      const r = at(key, site);
      return { kind: `tempo:${key}`, sample: (rng) => drawResolved(r, rng ?? stream(key)) };
    },
    gesture: () => {
      const m = d.current().motion;
      return { policy: m === 1 ? MOTION_REFERENCE : deriveMotion(m), rng: stream('gesture') };
    },
    enabled: (key) => d.enabled?.(key) ?? true,
  };
}

/**
 * Today's values, exactly: REFERENCE_TEMPO, no overrides, added keys off.
 * Phase F call sites always pass their own rng, so the seeded streams serve
 * only callers that ask for them (`draw`, `sample()` without an rng).
 */
export function referenceTempoSource(launchSeed = 0): TempoSource {
  return tempoSource({
    current: () => REFERENCE_TEMPO,
    launchSeed,
    enabled: (key) => !('added' in TEMPO_SPECS[key].identity),
  });
}

let shared: TempoSource | null = null;

/** The injected source, or one shared reference source (consumers whose wiring has none yet). */
export function tempoOrReference(tempo: TempoSource | undefined): TempoSource {
  if (tempo !== undefined) return tempo;
  shared ??= referenceTempoSource();
  return shared;
}
