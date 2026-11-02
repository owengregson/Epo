import type { ChurnActionOutcome } from './churn-types';

/** Failure to verify a dispatched write is uncertainty, never permission to replay it. */
export function normalizeMutationOutcome(outcome: ChurnActionOutcome, dispatched: boolean): ChurnActionOutcome {
  if (!dispatched || outcome.status !== 'failed') return outcome;
  return { status: 'blocked', cause: outcome.cause === 'rate-limited' ? 'rate-limited' : 'tab-unhealthy',
    unverifiedClick: true };
}
