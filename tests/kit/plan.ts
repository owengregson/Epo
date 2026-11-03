/**
 * Plan-core fakes (ADR 0607): a balanced Standard intent built straight from the kernel, an empty
 * demand, and helpers that draw a plan-day for a window. Suites override only what they test.
 */

import type { UsageTally } from '@/governors/plan-types';
import type { PlanViewInputs } from '@/governors/plan-view';
import {
  ACTIVITY,
  CAUTION,
  dailyHardCeiling,
  dayShapeBumps,
  overnightFloor,
  PATIENCE,
  REST_DAY_PCT,
  RHYTHM,
  SESSION,
  VARIANCE_PCT,
  weeklyWeights,
} from '@/kernel/derive';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { planDayWindow, quietMinute } from '@/kernel/plan/circadian';
import type { CircadianShape, DayPlan, DrawInput, PlanDayWindow, PlanDemand, PlanIntent } from '@/kernel/plan/types';
import { POLICY, SCALES } from '@/kernel/policy';
import { REFERENCE_TEMPO } from '@/kernel/tempo';
import { MS_PER_DAY, MS_PER_SECOND } from '@/kernel/units';

/** The balanced day shape over the realistic week. */
export const BALANCED_SHAPE: CircadianShape = {
  bumps: dayShapeBumps('balanced'),
  overnightFloor: overnightFloor('balanced'),
  weekdayWeights: weeklyWeights('realistic'),
  weekendShiftHours: EMPIRICAL.HUMAN_CIRCADIAN.weekendShiftHours,
};

/** The derived quiet window for "Through the day" (≈ 23:30–06:00). */
export const THROUGH_THE_DAY_QUIET = { startMinute: 23 * 60 + 30, endMinute: 6 * 60 } as const;

/** Balanced persona at Standard caution, moderate activity, natural consistency, sessions rhythm. */
export function testIntent(over: Partial<PlanIntent> = {}): PlanIntent {
  return {
    operatingRate: ACTIVITY.moderate,
    hardCeiling: dailyHardCeiling('moderate'),
    hourlyCap: CAUTION.standard.cap,
    probationHourlyCap: CAUTION.cautious.cap,
    unfollowHourlyCap: CAUTION.standard.cap,
    sessions: { min: RHYTHM.sessions.min, max: RHYTHM.sessions.max },
    gap: {
      medianMs: RHYTHM.sessions.gapMedianSeconds * MS_PER_SECOND,
      sigma: SESSION.GAP_SIGMA,
      floorMs: CAUTION.standard.floorSeconds * MS_PER_SECOND,
      capMs: SESSION.GAP_CAP_MS,
      hawkesAlpha: SESSION.HAWKES_ALPHA,
      hawkesTauMs: SESSION.HAWKES_TAU_MS,
    },
    gapTargetOverrideMs: null,
    gapFloorOverrideMs: null,
    volumeSigma: VARIANCE_PCT.natural / 100,
    restDayProbability: REST_DAY_PCT.natural / 100,
    consistencyScale: SCALES.consistency.natural,
    cleanupShare: 0,
    cleanupPerDayCap: null,
    patienceWaitMs: PATIENCE.normal.waitDays * MS_PER_DAY,
    checkSpacingOverrideMs: null,
    acceptRequests: true,
    shape: BALANCED_SHAPE,
    quietHours: THROUGH_THE_DAY_QUIET,
    daysOff: [],
    tempoOverrides: {},
    planBuffer: POLICY.PLAN_BUFFER,
    ...over,
  };
}

/** No work waiting anywhere: a fresh install's demand. */
export function emptyDemand(over: Partial<PlanDemand> = {}): PlanDemand {
  return {
    lifecycleDueByDayEnd: 0,
    lifecycleBacklog: 0,
    pruneStock: 0,
    protectedReeval: 0,
    journalPending: 0,
    followsDoneToday: 0,
    outsideToday: 0,
    pendingRequests: 0,
    acceptsRecent: 0,
    ownHeader: { followers: null, following: null },
    census: { lastCompleteAt: null, rowsPerPage: null },
    ...over,
  };
}

/** The plan-day window holding `at` for an intent at a phase (the intent's quiet minute). */
export function windowFor(at: number, intent: PlanIntent = testIntent(), phase = 0): PlanDayWindow {
  return planDayWindow(at, quietMinute(intent.shape, phase, intent.quietHours));
}

/** A draw input for the plan-day holding `at`: first opened at its start unless overridden. */
export function drawInput(at: number, over: Partial<DrawInput> = {}): DrawInput {
  const intent = over.intent ?? testIntent();
  const window = over.window ?? windowFor(at, intent, over.phaseOffsetHours ?? 0);
  return {
    installEntropy: 0x5eed,
    window,
    intent,
    demand: emptyDemand(),
    phaseOffsetHours: 0,
    firstOpenAt: window.startsAt,
    boost: null,
    runIntent: 'running',
    ...over,
  };
}

/** A usage tally with nothing used; override what a case needs. */
export function noUse(over: Partial<UsageTally> = {}): UsageTally {
  return { all: 0, auto: 0, manual: 0, follow: 0, unfollow: 0, accept: 0, perSession: [], outside: 0, ...over };
}

/** View inputs for a plan at `now`: running, no Boost, no ledger, nothing blocked. */
export function viewInputs(plan: DayPlan, now: number, over: Partial<PlanViewInputs> = {}): PlanViewInputs {
  const intent = over.intent ?? testIntent();
  const qm = quietMinute(intent.shape, 0, intent.quietHours);
  return {
    now,
    used: noUse(),
    boost: null,
    runIntent: 'running',
    hourly: { lastHour: 0, recentTimes: [] },
    deadline: null,
    tomorrow: () => null,
    journal: { blocks: () => false },
    lastMutationBefore: () => null,
    unconfirmed: null,
    surfacePaused: () => false,
    intent,
    ambient: REFERENCE_TEMPO,
    probationTempo: (idx) => ({ ...plan.sessions[idx].tempo, probation: true }),
    windowOf: (t) => planDayWindow(t, qm),
    provisional: false,
    upgradeProbation: false,
    ...over,
  };
}

/** The consistency rungs as (σ, rest probability, scale), from the kernel tables. */
export const CONSISTENCIES = (['clockwork', 'natural', 'erratic'] as const).map((k) => ({
  name: k,
  volumeSigma: VARIANCE_PCT[k] / 100,
  restDayProbability: REST_DAY_PCT[k] / 100,
  consistencyScale: SCALES.consistency[k],
}));
