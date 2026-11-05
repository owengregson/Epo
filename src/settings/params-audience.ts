/**
 * The audience and exploration rows of the parameter catalog (spec §6.5): who to follow (the follower
 * range, the follow-back curve, the private edge and the scoring details) and when to move on from a
 * source. Every row is neutral; the guards bound the safe side.
 */
import { audienceCurve, audienceRange } from '@/kernel/derive-audience';
import { SETTINGS_GUARDS as G, SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { DeriveCtx, ParamSpec } from './params-spec';

const { whole, share } = SETTINGS_POLICY.PARAM_STEP;
const { RECOMMENDED } = SETTINGS_POLICY;
const ROW = { kind: 'number', step: share, needs: null, deps: [], risk: 'neutral', applies: 'now' } as const;

export const AUDIENCE_SPECS = {
  'audience.followerRange': {
    ...ROW, kind: 'range', step: whole, section: 'audience', unit: 'followers',
    derive: (c: DeriveCtx) => audienceRange(c.intent.audienceSize),
    bounds: () => ({ min: G.followerMin.min, max: G.followerMax.max }),
  },
  'audience.ratioCurve': {
    ...ROW, kind: 'curve', section: 'audience', unit: 'ratio',
    derive: (c: DeriveCtx) => audienceCurve(c.intent.audienceFocus),
    bounds: () => G.ratioPoint,
  },
  'audience.privateBoost': {
    ...ROW, section: 'audience', unit: 'share',
    derive: (c: DeriveCtx) => (c.intent.preferPrivate ? SETTINGS_POLICY.PRIVATE_EDGE : 0),
    bounds: () => G.privateBoost,
  },
  'audience.mutualWeight': {
    ...ROW, section: 'audience', unit: 'factor',
    derive: () => RECOMMENDED.mutualWeight,
    bounds: () => G.mutualWeight,
  },
  'audience.mutualCap': {
    ...ROW, kind: 'int', step: whole, section: 'audience', unit: 'count',
    derive: () => RECOMMENDED.mutualCap,
    bounds: () => G.mutualCap,
  },
  'audience.bandEdgeScore': {
    ...ROW, section: 'audience', unit: 'share',
    derive: () => RECOMMENDED.bandEdgeScore,
    bounds: () => G.bandEdgeScore,
  },
  'explore.moveOnRate': {
    ...ROW, section: 'explore', unit: 'share',
    derive: () => RECOMMENDED.minFollowBackRate,
    bounds: () => G.moveOnRate,
  },
  'explore.moveOnPool': {
    ...ROW, kind: 'int', step: whole, section: 'explore', unit: 'followers',
    derive: () => RECOMMENDED.minPoolSize,
    bounds: () => G.moveOnPool,
  },
  'explore.refillBelow': {
    ...ROW, kind: 'int', step: whole, section: 'explore', unit: 'count',
    derive: () => RECOMMENDED.lowWaterCandidates,
    bounds: () => G.refillBelow,
  },
} satisfies Record<string, ParamSpec>;
