/**
 * The Advanced parameter vocabulary (spec §6.5, Appendix B.4): the catalog's
 * keys, sections, kinds, units, risk and when a change applies. Pure, no imports.
 */

export const T2_PARAM_KEYS = [
  'pace.dailyVolume', 'pace.dailyCeiling', 'pace.hourlyCap', 'pace.dayVariation', 'pace.restDayChance',
  'pace.candidateBuffer',
  'sessions.perDayMin', 'sessions.perDayMax', 'sessions.gapTypical', 'sessions.gapMinimum',
  'unfollow.waitDays', 'unfollow.holdDays', 'unfollow.cleanupShare', 'unfollow.cleanupPerDay',
  'unfollow.censusEveryDays', 'unfollow.attempts', 'checks.everyHours',
  'audience.followerRange', 'audience.ratioCurve', 'audience.privateBoost', 'audience.mutualWeight',
  'audience.mutualCap', 'audience.bandEdgeScore',
  'explore.moveOnRate', 'explore.moveOnPool', 'explore.refillBelow',
] as const;

export type ParamKey = (typeof T2_PARAM_KEYS)[number];

export type SectionId =
  | 'pace' | 'schedule' | 'audience' | 'unfollow' | 'protection' | 'boost' | 'app'
  | 'timing' | 'explore' | 'limits' | 'technical' | 'diagnostics';

/** The seven Easy sections, in order. */
export const EASY_SECTIONS = [
  'pace', 'schedule', 'audience', 'unfollow', 'protection', 'boost', 'app',
] as const satisfies readonly SectionId[];

export type ParamKind = 'int' | 'number' | 'range' | 'curve' | 'bool';
export type ParamUnit =
  | 'per-day' | 'per-hour' | 'percent' | 'count' | 'seconds' | 'ms' | 'hours' | 'days'
  | 'share' | 'ratio' | 'followers' | 'factor';
export type ParamRisk = 'higher-is-riskier' | 'lower-is-riskier' | 'neutral';
export type ApplyWhen = 'now' | 'replan' | 'next-day' | 'next-start';

export const RISK_LEVELS = ['low', 'standard', 'elevated', 'at-limit'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
