/**
 * The unfollowing rows of the parameter catalog (spec §6.5): follow-back wait and hold, pruning share and
 * daily cap, census spacing, attempts, and the follow-back check spacing (slower only, ≥ the briskest
 * derived spacing). The interim recommendations hold until the plan capability is on (spec C16).
 */
import { CLEANUP, PATIENCE } from '@/kernel/derive';
import { checkSpacingHours, ENVELOPE } from '@/kernel/derive-envelope';
import { BOUNDS } from '@/kernel/policy';
import { SETTINGS_GUARDS as G, SETTINGS_POLICY } from '@/kernel/settings-policy';
import type { Intent } from '@/shared/settings-intent';
import { type DeriveCtx, num, type ParamSpec } from './params-spec';

const { whole, share, hours } = SETTINGS_POLICY.PARAM_STEP;
const { INTERIM } = SETTINGS_POLICY;
const ROW = { kind: 'int', step: whole, needs: null, deps: [], section: 'unfollow' } as const;

const cleanupOff = (i: Intent): 'cleanup-off' | null => (i.cleanup === 'off' ? 'cleanup-off' : null);

export const LIFECYCLE_SPECS = {
  'unfollow.waitDays': {
    ...ROW, unit: 'days', risk: 'lower-is-riskier', applies: 'now',
    derive: (c: DeriveCtx) => PATIENCE[c.intent.patience].waitDays,
    bounds: () => ({ min: Math.max(G.waitDays.min, ENVELOPE.waitDays.min), max: G.waitDays.max }),
  },
  'unfollow.holdDays': {
    ...ROW, unit: 'days', risk: 'lower-is-riskier', applies: 'now',
    derive: (c: DeriveCtx) => PATIENCE[c.intent.patience].holdDays,
    bounds: () => ({ min: Math.max(G.holdDays.min, ENVELOPE.holdDays.min), max: G.holdDays.max }),
    inactive: (i: Intent) => (i.mutuals === 'keep' ? 'mutuals-kept' : null),
  },
  'unfollow.cleanupShare': {
    ...ROW, kind: 'number', step: share, unit: 'share', risk: 'higher-is-riskier', applies: 'replan',
    derive: (c: DeriveCtx) =>
      Math.min(CLEANUP[c.intent.cleanup].fraction, BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION),
    bounds: () => ({ min: G.cleanupShare.min, max: ENVELOPE.cleanupShare.max }),
    inactive: cleanupOff,
  },
  'unfollow.cleanupPerDay': {
    ...ROW, unit: 'per-day', risk: 'higher-is-riskier', applies: 'replan', deps: ['pace.dailyCeiling'],
    // With the plan the day's pruning is the plan's; an override only lowers it, so the ceiling recommends.
    derive: (c: DeriveCtx) => (c.plan ? num(c, 'pace.dailyCeiling') : INTERIM.pruneDailyLimit),
    bounds: (c: DeriveCtx) => ({ min: G.cleanupPerDay.min, max: num(c, 'pace.dailyCeiling') }),
    inactive: cleanupOff,
  },
  'unfollow.censusEveryDays': {
    ...ROW, unit: 'days', risk: 'lower-is-riskier', applies: 'replan', deps: ['unfollow.waitDays'],
    // With the plan the census slot follows the follow-back wait.
    derive: (c: DeriveCtx) => (c.plan ? num(c, 'unfollow.waitDays') : INTERIM.pruneScheduleDays),
    bounds: () => G.censusEveryDays,
    inactive: cleanupOff,
  },
  'unfollow.attempts': {
    ...ROW, unit: 'count', risk: 'neutral', applies: 'now',
    derive: (c: DeriveCtx) => c.math.retryLimit(),
    bounds: () => G.attempts,
  },
  'checks.everyHours': {
    ...ROW, kind: 'number', step: hours, unit: 'hours', risk: 'lower-is-riskier', applies: 'replan',
    derive: (c: DeriveCtx) => (c.plan ? checkSpacingHours(1) : INTERIM.followbackSweepHours),
    bounds: () => ({ min: ENVELOPE.checksEveryHours.min, max: G.checksEveryHours.max }),
  },
} satisfies Record<string, ParamSpec>;
