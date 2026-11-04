/**
 * The read allowance for the CURRENT settings (kernel D6, spec §5.8 layer 1): the plan-day totals the
 * read budget enforces per plan-day and over any trailing 24 h, from the live intent and the plan's own
 * census sizing (the own header and the measured page size; unknown keeps today's bound). Nothing here
 * is a number of its own.
 */
import type { PlanReadAllowance } from '../kernel/derive-reads';
import type { PlanDemand } from '../kernel/plan';
import { type PlanReadFacts, planReadAllowance } from '../kernel/plan/reads';
import { BOUNDS_REENTRY } from '../kernel/reentry-policy';
import type { EffectiveSettings } from './effective';
import { toPlanIntent } from './plan-intent';

/** The demand fields the census term sizes from. */
export type CensusSizing = Pick<PlanDemand, 'ownHeader' | 'census'>;

const UNKNOWN_HEADER: CensusSizing = {
  ownHeader: { followers: null, following: null },
  census: { lastCompleteAt: null, rowsPerPage: null },
};

/** The rest of a demand snapshot reads as none: the allowance sizes from the limits and the census alone. */
const NO_DEMAND: Omit<PlanDemand, keyof CensusSizing> = {
  lifecycleDueByDayEnd: 0, lifecycleBacklog: 0, pruneStock: 0, protectedReeval: 0, journalPending: 0,
  followsDoneToday: 0, outsideToday: 0, pendingRequests: 0, acceptsRecent: 0,
};

/** The census term's following pages (spec §9.2 step G): the plan and every allowance size with the same facts. */
export const PLAN_READ_FACTS: PlanReadFacts = { followingWalkPages: BOUNDS_REENTRY.FOLLOWING_WALK_PAGES };

export function toReadAllowance(e: EffectiveSettings, sizing: CensusSizing = UNKNOWN_HEADER): PlanReadAllowance {
  return planReadAllowance(toPlanIntent(e), { ...NO_DEMAND, ownHeader: sizing.ownHeader, census: sizing.census }, PLAN_READ_FACTS);
}
