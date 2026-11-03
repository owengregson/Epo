/**
 * Resolving a tempo spec at a session tempo (ADR 0607, spec §5.11).
 *
 * `scaleAbove` is the one scaling rule: a value moves away from its floor by the
 * factor, so it is the identity at f = 1 and never crosses the floor for f ≥ 0.
 * A `pace-up` base is the exception: it multiplies by max(1, pace), so it is
 * never shorter than its prior and longer on a relaxed session.
 */

import { EMPIRICAL } from '../fundamentals';
import { MOTION } from '../motion-policy';
import type { SessionTempo } from '../plan/types';
import { normal01 } from '../schedule';
import { SETTINGS_POLICY } from '../settings-policy';
import type { TempoAxis, TempoKey } from './keys';
import { type Prior, TEMPO_SPECS, type TempoSpec } from './specs';

/** A call site's own numbers, for keys whose prior or floor is relative to it (`pause.retry`). */
export interface TempoSite {
  readonly baseMs: number;
  readonly pollMs?: number;
}

/** A spec resolved at a tempo: the distribution to draw from and the floor it respects. */
export interface Resolved {
  readonly key: TempoKey;
  readonly prior: Prior;
  readonly floorValue: number;
}

/** `floor + (value − floor) × factor`: identity at 1, never below the floor for factor ≥ 0. */
export function scaleAbove(value: number, floor: number, factor: number): number {
  return floor + (value - floor) * factor;
}

/** Bounded re-draws of a clamped log-normal before projecting onto the nearer bound. */
const CLAMP_REDRAWS = 4;
/** A stride draw stays strictly inside its page band. */
const STRIDE_U_MAX = 0.999999;

/** The lowest value a prior draws (a mix's own component is `alt`). */
export function priorMin(p: Prior, tempo: SessionTempo, site?: TempoSite): number {
  switch (p.shape) {
    case 'band': case 'logn': case 'pages': return p.min;
    case 'mix': return priorMin(p.alt, tempo, site);
    case 'scale': return p.value * (1 - p.spread);
    case 'base': return p.value;
    case 'relative': return site === undefined ? p.lo : site.baseMs * p.lo;
    case 'travel': return MOTION.moveMinMs;
    case 'gap': return tempo.gap.floorMs * tempo.gap.timeScale;
  }
}

function floorValue(spec: TempoSpec, tempo: SessionTempo, site?: TempoSite): number {
  const f = spec.floor;
  switch (f.kind) {
    case 'latency': return EMPIRICAL.LATENCY[f.op].p50;
    case 'display': return EMPIRICAL.DISPLAY.perceptionMs;
    case 'prior-min': case 'equals-prior': return priorMin(spec.prior, tempo, site);
    case 'prior-min-of': return priorMin(TEMPO_SPECS[f.key].prior, tempo);
    case 'poll': return site?.pollMs ?? 0;
    case 'boundary': return EMPIRICAL.HUMAN_SESSION_BOUNDARY_MS.value;
    case 'px': return f.px;
    case 'pages': return f.pages;
    case 'caution-floor': return tempo.gap.floorMs * tempo.gap.timeScale;
  }
}

function axisFactor(axis: TempoAxis, tempo: SessionTempo): number {
  switch (axis) {
    case 'pace': return tempo.pace;
    case 'pace-up': return Math.max(1, tempo.pace);
    case 'motion': return tempo.motion;
    case 'depth': return tempo.depth;
  }
}

/** An override only lengthens, and never past the step watchdog's margin (§5.11, law L-ENV). */
function overrideFactor(o: number): number {
  return Number.isFinite(o) ? Math.min(SETTINGS_POLICY.TEMPO_OVERRIDE_MAX_FACTOR, Math.max(1, o)) : 1;
}

function scaled(p: Prior, floor: number, f: number, axis: TempoAxis, tempo: SessionTempo): Prior {
  switch (p.shape) {
    case 'band': return { shape: 'band', min: scaleAbove(p.min, floor, f), max: scaleAbove(p.max, floor, f) };
    case 'logn': return { ...p, median: scaleAbove(p.median, floor, f), min: scaleAbove(p.min, floor, f),
      max: scaleAbove(p.max, floor, f) };
    case 'mix': return { ...p, base: scaled(p.base, priorMin(p.base, tempo), f, axis, tempo),
      alt: scaled(p.alt, floor, f, axis, tempo) };
    case 'pages': return { shape: 'pages', min: Math.max(floor, Math.round(scaleAbove(p.min, floor, f))),
      max: Math.max(floor, Math.round(scaleAbove(p.max, floor, f))) };
    case 'scale': return { ...p, value: p.value * f };
    case 'base': return { shape: 'base', value: axis === 'pace-up' ? Math.max(floor, p.value * f) : scaleAbove(p.value, floor, f) };
    default: return p;
  }
}

/** The spec for `key` at `tempo`: the prior at tempo 1, scaled by its axis and the override factor. */
export function resolve(key: TempoKey, tempo: SessionTempo, override = 1, site?: TempoSite): Resolved {
  const spec = TEMPO_SPECS[key];
  const floor = floorValue(spec, tempo, site);
  const own = spec.prior.shape === 'relative' && site !== undefined
    ? { shape: 'band', min: site.baseMs * spec.prior.lo, max: site.baseMs * spec.prior.hi } as const
    : spec.prior;
  const f = axisFactor(spec.axis, tempo) * overrideFactor(override);
  return { key, prior: f === 1 ? own : scaled(own, floor, f, spec.axis, tempo), floorValue: floor };
}

/** One draw from a resolved spec (the same algorithms, and rng consumption, as `src/timing`). */
export function drawResolved(r: Resolved, rng: () => number): number {
  return drawPrior(r.key, r.prior, rng);
}

function drawPrior(key: TempoKey, p: Prior, rng: () => number): number {
  switch (p.shape) {
    case 'band': {
      const lo = Math.max(0, p.min);
      const hi = Math.max(lo, p.max);
      return Math.round(lo + rng() * (hi - lo));
    }
    case 'logn': {
      const lo = Math.min(p.min, p.max);
      const hi = Math.max(p.min, p.max);
      let v = lo;
      for (let i = 0; i < CLAMP_REDRAWS; i += 1) {
        v = Math.round(Math.max(0, p.median) * Math.exp(Math.max(0, p.sigma) * normal01(rng)));
        if (v >= lo && v <= hi) return v;
      }
      return v < lo ? lo : hi;
    }
    case 'mix': return rng() < p.p ? drawPrior(key, p.alt, rng) : drawPrior(key, p.base, rng);
    case 'pages': return p.min + Math.floor(Math.min(STRIDE_U_MAX, Math.max(0, rng())) * (p.max - p.min + 1));
    case 'scale': return p.spread === 0 ? p.value : p.value * (1 + p.spread * (2 * rng() - 1));
    case 'base': return p.value;
    default: throw new RangeError(`tempo: ${key} draws from its call site (${p.shape})`);
  }
}

/** Where a resolved prior sits — the base a wait gate noises around. */
export function locationOf(r: Resolved): number {
  const at = (p: Prior): number => {
    switch (p.shape) {
      case 'band': case 'pages': return (p.min + p.max) / 2;
      case 'logn': return p.median;
      case 'mix': return (1 - p.p) * at(p.base) + p.p * at(p.alt);
      case 'scale': case 'base': return p.value;
      default: throw new RangeError(`tempo: ${r.key} has no single base (${p.shape})`);
    }
  };
  return at(r.prior);
}
