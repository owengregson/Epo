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
  /** Minimum follower count to qualify (skip dead or throwaway accounts). */
  minFollowers: number;
  /** Maximum follower count to qualify (skip celebrities). */
  maxFollowers: number;
  /** Additive score bonus applied to private accounts (a preference, not a gate). */
  privateBoost: number;
  /** The `ratioScore` value at the band edges (`bandLow`/`bandHigh`). */
  bandEdgeScore: number;
  /**
   * Mutual-follower saturation point: the follow-back advantage of shared
   * followers steeply diminishes past this many mutuals, so the mutual curve is
   * flat above it (20+ mutuals all score the same).
   */
  mutualCap: number;
  /**
   * Weight of the mutual-follower bonus. Mutuals are the strongest follow-back
   * predictor we have, so the default outweighs the entire ratio component: a
   * capped-mutuals account beats any zero-mutual account regardless of ratio.
   */
  mutualWeight: number;
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
  mutualCap: 20,
  mutualWeight: 1.5,
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

/**
 * Concave mutual-follower curve in [0, 1]: sqrt of the capped fraction, so the
 * FIRST few mutuals carry most of the signal (1 mutual ≈ 0.22, 5 ≈ 0.5,
 * cap ≈ 1) and everything at or past `mutualCap` scores identically flat.
 */
export function mutualScore(mutuals: number, cfg: ScorerConfig = SCORER_DEFAULTS): number {
  if (cfg.mutualCap <= 0) return 0;
  const m = Math.max(0, Math.min(mutuals, cfg.mutualCap));
  return Math.sqrt(m / cfg.mutualCap);
}

/** Result of scoring one candidate account. */
export interface CandidateScore {
  /**
   * Composite score; 0 when ineligible. The ratio + private-boost base lives in
   * [0, 1]; the mutual bonus adds up to `mutualWeight` on top (the score is a
   * RANKING key, not a probability), so the full range is [0, 1 + mutualWeight].
   */
  score: number;
  /** Whether the account qualifies for the churn pipeline. */
  eligible: boolean;
  /** Readable justifications (drivers for eligible, cause for rejection). */
  reasons: string[];
}

/**
 * Composite candidate score built on the ratio sweet spot plus hard qualifiers.
 *
 * Pure and deterministic: no store, no clock, no I/O. Hard-ineligible (score 0)
 * when the ratio is hard-excluded, the account is verified, or the follower count
 * is outside `[minFollowers, maxFollowers]`. Otherwise eligible with
 * `score = clamp01(ratioScore(r) + privateBoost?) + mutualWeight·mutualScore(m)`
 * — private accounts are preferred (§3.3, a boost rather than a requirement),
 * and shared followers dominate the ranking: mutuals are the strongest
 * follow-back predictor, saturating at `mutualCap` (20+ mutuals score alike).
 */
export function scoreCandidate(a: AccountState, cfg: ScorerConfig = SCORER_DEFAULTS): CandidateScore {
  // Counts-known FIRST: 'no-counts' means "await enrichment" to the Scanner
  // (the record is left in the pool), so it must only ever fire when counts
  // are genuinely missing. An enriched account with 0 followers used to fall
  // through here (its ratio is undefined) and sit in the pool forever as a
  // zombie — enriched, unscorable, never skipped.
  if (a.followers === undefined || a.following === undefined) {
    return { score: 0, eligible: false, reasons: ['no-counts'] };
  }
  if (a.isVerified === true) return { score: 0, eligible: false, reasons: ['verified'] };

  const followers = a.followers;
  if (followers < cfg.minFollowers) return { score: 0, eligible: false, reasons: ['too-small'] };
  if (followers > cfg.maxFollowers) return { score: 0, eligible: false, reasons: ['too-large'] };

  const r = a.ratio ?? ratioOf(a.followers, a.following);
  // Counts are known, so an undefined ratio means followers === 0 — which the
  // min-followers gate normally catches; a 0-minimum config still excludes it.
  if (r === undefined) return { score: 0, eligible: false, reasons: ['ratio-excluded'] };

  const rs = ratioScore(r, cfg);
  if (rs === 0) return { score: 0, eligible: false, reasons: ['ratio-excluded'] };

  const reasons: string[] = [];
  if (r >= cfg.peakLow && r <= cfg.peakHigh) reasons.push('peak-ratio');
  else if (r >= cfg.bandLow && r <= cfg.bandHigh) reasons.push('in-band');
  else reasons.push('soft-edge-penalty');

  let score = rs;
  if (a.isPrivate === true) {
    score += cfg.privateBoost;
    reasons.push('private-boost');
  }
  score = clamp01(score);

  // Mutual bonus rides ON TOP of the clamped base — the ranking must always
  // prefer shared-follower candidates, even among base-saturated peak accounts.
  if (a.mutuals !== undefined && a.mutuals > 0) {
    score += cfg.mutualWeight * mutualScore(a.mutuals, cfg);
    reasons.push('mutuals');
  }

  return { score, eligible: true, reasons };
}
