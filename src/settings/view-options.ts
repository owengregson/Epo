/**
 * The numbers behind every choice (spec §6.4, Appendix B.4 `OptionPreviews`): precomputed per revision so
 * a hover needs no IPC. Card numbers are the day law's median at the user's own consistency; risk and the
 * low-wall share come from the kernel; feasibility reads the user's schedule with its masks.
 */
import { ACTIVITY, CAUTION, CLEANUP, PATIENCE, REST_DAY_PCT, RHYTHM, VARIANCE_PCT } from '@/kernel/derive';
import { audienceCurve, audienceRange } from '@/kernel/derive-audience';
import { riskRung, shareOfLowWall } from '@/kernel/derive-envelope';
import { deriveQuietHours, hourlyIntensity, feasibility as kernelFeasibility, sessionMassMasked } from '@/kernel/derive-schedule';
import { BOUNDS } from '@/kernel/policy';
import { SETTINGS_POLICY } from '@/kernel/settings-policy';
import {
  ACTIVITY_LEVELS, type ActivityLevel, AUDIENCE_FOCUSES, AUDIENCE_SIZES, CAUTIONS, type Caution, CLEANUP_LEVELS,
  CONSISTENCIES, DAY_SHAPES, type Intent, PACE_CARDS, PATIENCES, type PaceCardId, RHYTHMS, WEEKDAYS,
} from '@/shared/settings-intent';
import { RISK_LEVELS } from '@/shared/settings-params';
import type { Feasibility, OptionPreviews, PaceOption } from '@/shared/settings-view';
import type { PlanMath } from './basis';
import type { EffectiveSettings } from './effective';
import { quietWindowOf } from './effective';

const each = <K extends string, V>(keys: readonly K[], f: (k: K) => V): Record<K, V> =>
  Object.fromEntries(keys.map((k) => [k, f(k)])) as Record<K, V>;

/** The kernel's feasibility in the view's shape. */
export function feasibilityOf(dailyVolume: number, hourlyCap: number, massHours: number): Feasibility {
  const f = kernelFeasibility({ dailyVolume, hourlyCap, massHours });
  return f.binding === null ? { kind: 'ok', reachablePerDay: f.reachablePerDay }
    : { kind: 'short', reachablePerDay: f.reachablePerDay, binding: f.binding };
}

/** The feasibility of an effective record's volume over its own masked schedule. */
export function feasibilityOfEffective(e: EffectiveSettings): Feasibility {
  const mass = sessionMassMasked({ dayShape: e.pattern.dayShape, weeklyShape: e.pattern.weeklyShape }, e.quietHours, e.daysOff);
  return feasibilityOf(e.dailyOperatingRate, e.hourlyVelocityCap, mass);
}

/** The masked session mass of an intent's schedule (quiet hours and days off at zero). */
export function massOf(i: Intent): number {
  return sessionMassMasked({ dayShape: i.dayShape, weeklyShape: i.weeklyShape }, quietWindowOf(i.quietHours, i.dayShape), i.daysOff);
}

export function paceOption(id: PaceCardId | ActivityLevel, activity: ActivityLevel, caution: Caution, e: EffectiveSettings, i: Intent, math: PlanMath): PaceOption {
  const operatingRate = ACTIVITY[activity];
  const cap = CAUTION[caution].cap;
  return {
    id,
    perDay: math.dayLaw({ operatingRate, dayVariationPct: e.dailyVolumeVariancePct, restDayPct: e.restDayChancePct }),
    perHourMax: cap,
    shareOfLowWall: shareOfLowWall(math.automaticDayMax(operatingRate)),
    risk: RISK_LEVELS[riskRung({ dailyVolume: operatingRate, hourlyCap: cap })],
    feasibility: feasibilityOf(operatingRate, cap, massOf(i)),
  };
}

/** A mid-week day: the weekday curve every schedule card previews. */
const PREVIEW_WEEKDAY = WEEKDAYS.indexOf('wed');

export function optionPreviews(i: Intent, e: EffectiveSettings, math: PlanMath): OptionPreviews {
  const { BOOST } = SETTINGS_POLICY;
  return {
    paceCards: (Object.keys(PACE_CARDS) as PaceCardId[]).map((id) => paceOption(id, PACE_CARDS[id].activity, PACE_CARDS[id].caution, e, i, math)),
    activity: each(ACTIVITY_LEVELS, (a) => paceOption(a, a, i.caution, e, i, math)),
    caution: each(CAUTIONS, (c) => ({ hourlyCap: CAUTION[c].cap, minGapSeconds: CAUTION[c].floorSeconds })),
    rhythm: each(RHYTHMS, (r) => ({ sessions: { min: RHYTHM[r].min, max: RHYTHM[r].max }, gapSeconds: RHYTHM[r].gapMedianSeconds })),
    consistency: each(CONSISTENCIES, (c) => ({ variationPct: VARIANCE_PCT[c], restDayPct: REST_DAY_PCT[c] })),
    schedule: DAY_SHAPES.map((dayShape) => {
      const at = { ...i, dayShape };
      return {
        dayShape, intensity: hourlyIntensity(dayShape, i.weeklyShape, PREVIEW_WEEKDAY),
        quiet: i.quietHours.kind === 'derived' ? deriveQuietHours(dayShape) : quietWindowOf(i.quietHours, dayShape),
        feasibility: feasibilityOf(e.dailyOperatingRate, e.hourlyVelocityCap, massOf(at)),
      };
    }),
    patience: each(PATIENCES, (p) => ({ waitDays: PATIENCE[p].waitDays, holdDays: PATIENCE[p].holdDays })),
    cleanup: each(CLEANUP_LEVELS, (c) => ({ share: Math.min(CLEANUP[c].fraction, BOUNDS.PATTERN.MAX_UNFOLLOW_FRACTION_PER_SESSION) })),
    size: each(AUDIENCE_SIZES, audienceRange),
    focus: each(AUDIENCE_FOCUSES, audienceCurve),
    boostHours: { choices: [...BOOST.CHOICES], min: BOOST.MIN_HOURS, max: BOOST.MAX_HOURS },
  };
}
