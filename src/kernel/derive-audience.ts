/**
 * Tier 2 — the audience derivations of Settings (ADR 0608, spec §6.4): the follow-back curve per focus and
 * the follower range per account size. The curve type is kernel-local, structurally the shared `RatioCurve`.
 */

import { SETTINGS_POLICY } from './settings-policy';

export interface AudienceCurve {
  readonly hardLow: number;
  readonly bandLow: number;
  readonly peakLow: number;
  readonly peakHigh: number;
  readonly bandHigh: number;
  readonly hardHigh: number;
}

/**
 * `likely` is the policy curve; `wide` maps every bound `b ↦ c·(b/c)^AUDIENCE_WIDEN_FACTOR` around the
 * plateau's geometric centre `c = √(peakLow·peakHigh)`, so the curve widens in log space and the plateau stays.
 */
export function audienceCurve(focus: 'likely' | 'wide'): AudienceCurve {
  const base = SETTINGS_POLICY.RATIO_CURVE;
  if (focus === 'likely') return { ...base };
  const c = Math.sqrt(base.peakLow * base.peakHigh);
  const widen = (b: number): number => c * (b / c) ** SETTINGS_POLICY.AUDIENCE_WIDEN_FACTOR;
  return {
    hardLow: widen(base.hardLow), bandLow: widen(base.bandLow), peakLow: base.peakLow,
    peakHigh: base.peakHigh, bandHigh: widen(base.bandHigh), hardHigh: widen(base.hardHigh),
  };
}

/** The follower range an account size names. */
export function audienceRange(size: 'small' | 'everyday' | 'larger'): { min: number; max: number } {
  return { ...SETTINGS_POLICY.AUDIENCE_SIZE[size] };
}
