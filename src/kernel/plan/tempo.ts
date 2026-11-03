/**
 * The session tempo (ADR 0607, spec §5.9): one pace per session from a day latent and a session
 * latent, spread by the consistency knob and clamped to the beat band; motion = pace^½ (per gesture),
 * depth = 1/pace; the gap is solved per session. Boost never changes tempo; probation runs at H one
 * caution rung down with the drawn pace. Layering: `src/kernel/**` imports nothing from `src/`.
 */

import { NOISE } from '../derive';
import { POLICY } from '../policy';
import { TEMPO_POLICY } from '../tempo-policy';
import { solveGapSpec, targetMeanMs } from './gap';
import { z } from './seed';
import type { PlanIntent, SessionTempo } from './types';

/** The log-space spread of the pace draw: the band half-width at the central z, times consistency (.128 at Typical). */
export function paceSigma(consistencyScale: number): number {
  return (Math.log(1 + POLICY.BAND_HALF_WIDTH) / POLICY.DRAW_CENTRAL_Z) * Math.max(0, consistencyScale);
}

/** A pace factor from a standard-normal latent, clamped to the beat band [0.7, 1.45]. */
export function paceAt(latent: number, consistencyScale: number): number {
  const pace = Math.exp(paceSigma(consistencyScale) * latent);
  return Math.min(NOISE.BEAT_MAX_FACTOR, Math.max(NOISE.BEAT_MIN_FACTOR, pace));
}

/** The day latent `z('tempo-day')`: the ambient tempo between sessions. */
export function dayLatent(seed: number): number {
  return z(seed, 'tempo-day');
}

/** Session `s`'s latent: the day and session latents averaged to unit variance. */
export function sessionLatent(seed: number, s: number): number {
  return (dayLatent(seed) + z(seed, 'tempo', s)) / Math.SQRT2;
}

/** The tempo at a latent: pace, its motion and depth factors, and the gap solved at that pace. */
export function tempoAt(latent: number, intent: PlanIntent, flags: { readonly mix: 'normal' | 'boost'; readonly probation: boolean },
  hourlyCap: number, budget: number): SessionTempo {
  const pace = paceAt(latent, intent.consistencyScale);
  const gap = solveGapSpec(intent.gap, targetMeanMs(hourlyCap, pace, intent.gapTargetOverrideMs), budget, intent.gapFloorOverrideMs);
  return {
    z: latent,
    pace,
    motion: pace ** TEMPO_POLICY.MOTION_ELASTICITY,
    depth: 1 / pace,
    gap,
    mix: flags.mix,
    probation: flags.probation,
  };
}

/** Session `s`'s tempo; a probation session paces its gap against the probation hourly cap. */
export function sessionTempo(seed: number, s: number, intent: PlanIntent,
  flags: { readonly mix: 'normal' | 'boost'; readonly probation: boolean }, hourlyCap: number, budget: number): SessionTempo {
  return tempoAt(sessionLatent(seed, s), intent, flags, flags.probation ? Math.min(hourlyCap, intent.probationHourlyCap) : hourlyCap, budget);
}

/** The ambient tempo (no open session: catch-up, manual work, a run between sessions): z = z_day. */
export function ambientTempo(seed: number, intent: PlanIntent, budget: number): SessionTempo {
  return tempoAt(dayLatent(seed), intent, { mix: 'normal', probation: false }, intent.hourlyCap, budget);
}
