import { ratioOf, type AccountState } from '../store/types';

/**
 * Tunable knobs for candidate scoring. Defaults mirror the v3 design §3.2/§3.3
 * (ratio sweet spot + size band + private boost). All values are exposed in
 * Settings; this module never reads them from storage — pass a `ScorerConfig`.
 */
export interface ScorerConfig {
  /** Lower edge of the eligible ratio band (score = `bandEdgeScore` here). */
  bandLow: number;
  /** Upper edge of the eligible ratio band (score = `bandEdgeScore` here). */
  bandHigh: number;
  /** Lower edge of the full-score plateau. */
  peakLow: number;
  /** Upper edge of the full-score plateau. */
  peakHigh: number;
  /** Ratio below this is hard-excluded (score 0). */
  hardLow: number;
  /** Ratio above this is hard-excluded (score 0). */
  hardHigh: number;
  /** Minimum follower count to qualify (skip dead/bot accounts). */
  minFollowers: number;
  /** Maximum follower count to qualify (skip celebrities). */
  maxFollowers: number;
  /** Additive score bonus applied to private accounts (a preference, not a gate). */
  privateBoost: number;
  /** The `ratioScore` value at the band edges (`bandLow`/`bandHigh`). */
  bandEdgeScore: number;
}

/** Design defaults (v3 §3.2/§3.3). */
export const SCORER_DEFAULTS: ScorerConfig = {
  bandLow: 0.9,
  bandHigh: 1.5,
  peakLow: 1.0,
  peakHigh: 1.2,
  hardLow: 0.5,
  hardHigh: 3.0,
  minFollowers: 50,
  maxFollowers: 20000,
  privateBoost: 0.15,
  bandEdgeScore: 0.6,
};

/** Clamp a number into the closed unit interval [0, 1]. */
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Plateau-peaked ratio score in [0, 1] for `r = following ÷ followers`.
 *
 * Piecewise-linear and continuous:
 *   r < hardLow            → 0                        (excluded)
 *   [hardLow, bandLow)     → 0 … bandEdgeScore        (heavily-penalized soft edge)
 *   [bandLow, peakLow)     → bandEdgeScore … 1        (rising into the plateau)
 *   [peakLow, peakHigh]    → 1                         (the sweet-spot plateau)
 *   (peakHigh, bandHigh]   → 1 … bandEdgeScore         (falling off the plateau)
 *   (bandHigh, hardHigh]   → bandEdgeScore … 0         (heavily-penalized soft edge)
 *   r > hardHigh           → 0                         (excluded)
 */
export function ratioScore(r: number, cfg: ScorerConfig = SCORER_DEFAULTS): number {
  const { bandLow, bandHigh, peakLow, peakHigh, hardLow, hardHigh, bandEdgeScore } = cfg;
  if (r < hardLow || r > hardHigh) return 0;
  if (r < bandLow) {
    // Soft lower edge: 0 at hardLow → bandEdgeScore at bandLow.
    return bandEdgeScore * ((r - hardLow) / (bandLow - hardLow));
  }
  if (r < peakLow) {
    // Rising into the plateau: bandEdgeScore at bandLow → 1 at peakLow.
    return bandEdgeScore + (1 - bandEdgeScore) * ((r - bandLow) / (peakLow - bandLow));
  }
  if (r <= peakHigh) {
    // The full-score plateau.
    return 1;
  }
  if (r <= bandHigh) {
    // Falling off the plateau: 1 at peakHigh → bandEdgeScore at bandHigh.
    return 1 - (1 - bandEdgeScore) * ((r - peakHigh) / (bandHigh - peakHigh));
  }
  // Soft upper edge: bandEdgeScore at bandHigh → 0 at hardHigh.
  return bandEdgeScore * (1 - (r - bandHigh) / (hardHigh - bandHigh));
}

/** Result of scoring one candidate account. */
export interface CandidateScore {
  /** Composite score in [0, 1]; 0 when ineligible. */
  score: number;
  /** Whether the account qualifies for the churn pipeline. */
  eligible: boolean;
  /** Human-readable justifications (drivers for eligible, cause for rejection). */
  reasons: string[];
}

/**
 * Composite candidate score built on the ratio sweet spot plus hard qualifiers.
 *
 * Pure and deterministic: no store, no clock, no I/O. Hard-ineligible (score 0)
 * when the ratio is hard-excluded, the account is verified, or the follower count
 * is outside `[minFollowers, maxFollowers]`. Otherwise eligible with
 * `score = clamp01(ratioScore(r) + privateBoost?)` — private accounts are
 * preferred (§3.3), a boost rather than a requirement.
 */
export function scoreCandidate(a: AccountState, cfg: ScorerConfig = SCORER_DEFAULTS): CandidateScore {
  const r = a.ratio ?? ratioOf(a.followers, a.following);
  if (r === undefined) return { score: 0, eligible: false, reasons: ['no-counts'] };

  const rs = ratioScore(r, cfg);
  if (rs === 0) return { score: 0, eligible: false, reasons: ['ratio-excluded'] };
  if (a.isVerified === true) return { score: 0, eligible: false, reasons: ['verified'] };

  const followers = a.followers;
  if (followers === undefined) return { score: 0, eligible: false, reasons: ['no-counts'] };
  if (followers < cfg.minFollowers) return { score: 0, eligible: false, reasons: ['too-small'] };
  if (followers > cfg.maxFollowers) return { score: 0, eligible: false, reasons: ['too-large'] };

  const reasons: string[] = [];
  if (r >= cfg.peakLow && r <= cfg.peakHigh) reasons.push('peak-ratio');
  else if (r >= cfg.bandLow && r <= cfg.bandHigh) reasons.push('in-band');
  else reasons.push('soft-edge-penalty');

  let score = rs;
  if (a.isPrivate === true) {
    score += cfg.privateBoost;
    reasons.push('private-boost');
  }

  return { score: clamp01(score), eligible: true, reasons };
}
