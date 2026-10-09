/**
 * Verdict → the Actor's PUBLIC contract.
 *
 * The arbitration produces a {@link Verdict} carrying its own record effect;
 * this maps it onto what the rest of the app still speaks — `Result<{clicked}>`
 * plus the two thrown error classes the recovery ladder keys off — so
 * `churn-actions.ts` keeps returning the `ChurnActionOutcome` the engine
 * consumes and nothing outside the adapter changes this wave.
 *
 * It lives in its own module because it is the SEAM: wave B moves the engine
 * onto the Verdict's `effect` and deletes this file whole, along with
 * `ActionRateLimitedError` and `ActionBlockedError`.
 *
 * The switch is total. A new verdict kind is a compile error here — which is
 * exactly how "record untouched on block" stops being a convention maintained
 * across four files.
 */

import { ActionBlockedError, ActionRateLimitedError, AdapterStaleError } from '@/adapter/errors';
import { describeVerdict, type Verdict } from '@/adapter/verdict';
import * as logger from '@/utils/logger';
import { err, ok, type Result } from '@/utils/result';

export function verdictToResult(
  verdict: Verdict,
  op: string,
  username: string,
): Result<{ clicked: boolean }> {
  logger.info(`${op}: verdict`, { username, verdict: describeVerdict(verdict) });
  switch (verdict.kind) {
    case 'landed':
      return ok({ clicked: true });
    case 'noop':
      return ok({ clicked: false });
    case 'throttled':
      // DEFINITIVE: Instagram's server refused. The ladder enters on the first
      // one; the record is left exactly as it was.
      logger.warn(`${op}: Instagram refused the action as rate-limited`, {
        username,
        status: verdict.evidence.httpStatus ?? 0,
        detail: verdict.detail,
      });
      throw new ActionRateLimitedError(op, verdict.evidence.httpStatus ?? 0, verdict.detail);
    case 'walled':
      logger.warn(`${op}: a wall answered the action`, {
        username,
        wall: verdict.wall,
        detail: verdict.detail,
      });
      throw new ActionBlockedError(op, verdict.detail);
    case 'refused':
      return err(
        verdict.evidence.source === 'response'
          ? `${op}: Instagram refused the action for ${username} (HTTP ${verdict.evidence.httpStatus ?? 0}: ${verdict.detail})`
          : `${op}: post-click state not confirmed for ${username}`,
      );
    case 'ambiguous':
      // Reserved for the post-click stall, which stays an exception this wave
      // (`TabUnresponsiveError` with `phase: 'post-click'`, ADR 0206).
      return err(`${op}: click dispatched but unverified for ${username}`);
    case 'drift':
      throw new AdapterStaleError(op, verdict.control);
  }
}
