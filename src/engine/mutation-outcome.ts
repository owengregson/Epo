import type { ChurnActionOutcome } from './churn-types';

/** What Instagram showed about a dispatched write that did not land: something, or nothing at all. */
export type DispatchEvidence = 'instagram' | 'none';

/**
 * Failure to verify a dispatched write is uncertainty, never permission to replay it. With no Instagram
 * evidence (no response, no refusal text, header unchanged) it is unverified (spec §11.1 F7): a park, never a wall.
 */
export function normalizeMutationOutcome(outcome: ChurnActionOutcome, dispatched: boolean,
  evidence: DispatchEvidence = 'instagram'): ChurnActionOutcome {
  if (!dispatched || outcome.status !== 'failed') return outcome;
  // The churn port's cause vocabulary has no `unverified` yet: the absent cause on an unverified click is it.
  if (evidence === 'none') return { status: 'blocked', unverifiedClick: true };
  return { status: 'blocked', cause: outcome.cause === 'rate-limited' ? 'rate-limited' : 'tab-unhealthy',
    unverifiedClick: true };
}

/** Whether an outcome is the unverified one: dispatched, unanswered, and no rate-wall signal by itself. */
export const isUnverifiedOutcome = (outcome: ChurnActionOutcome | null | undefined): boolean =>
  outcome?.status === 'blocked' && outcome.unverifiedClick === true && outcome.cause === undefined;
