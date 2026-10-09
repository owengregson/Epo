/**
 * The per-candidate prune decision, as ONE pure function.
 *
 * The three correctness rules a prune must never lose live here, so the
 * standalone run loop and the woven growth feed cannot drift apart:
 *
 *  1. **Whitelist re-derivation.** The keep-list is applied at CONSUMPTION time,
 *     never at scan time, so an edit made between Scan and Run — or mid-run — is
 *     honoured for every candidate from that moment on.
 *  2. **The live-graph follows-us guard** (PRINCIPLES §2). The graph can know
 *     MORE than the census this run is draining: a notifications check or an
 *     accepted follow request records a follows-us edge AFTER the scan. We never
 *     unfollow someone the graph says follows us NOW. This is also what makes a
 *     longer scan-freshness window safe — staleness in the dangerous direction
 *     is caught here.
 *  3. **A stub row without a username is skipped**, never guessed at: the DOM
 *     unfollow needs a handle, and the row will have one after a later scan.
 *
 * Deliberately ABSENT: the bio keep-list. It protects only accounts that FOLLOW
 * US BACK (the churn scheduler's held-rotation gate); a prune candidate by
 * definition does not, so a bio never shields one.
 *
 * Pure: no store, no clock, no IG. The caller supplies the live readings and
 * owns what a skip CONSUMES — a whitelisted skip must not spend an actionable
 * slot, while a followed-back / no-username skip visits the row.
 */

import { isPruneWhitelisted, pruneWhitelistSet } from './prune-whitelist';

/** A census row as both prune paths hold it. */
export interface PruneSubject {
  pk: string;
  username: string | null;
}

/** The live readings the decision needs; every one is supplied by the caller. */
export interface PruneCandidateInput {
  candidate: PruneSubject;
  /** The whitelist AS IT STANDS NOW (rule 1). */
  whitelist: readonly string[];
  /** What the LIVE graph says about `candidate → us` right now (rule 2). */
  followsUsNow: boolean;
}

export type PruneSkipReason = 'whitelisted' | 'followed-back' | 'no-username';

/**
 * What to do with one candidate. `unfollow` carries the username, so the caller
 * cannot reach the DOM action without one (rule 3 as a type, not a check).
 */
export type PruneCandidateVerdict =
  | { do: 'unfollow'; pk: string; username: string }
  | { do: 'skip'; pk: string; reason: PruneSkipReason };

/**
 * The decision, in the order both call sites have always used: whitelist, then
 * the live-graph guard, then the username requirement.
 */
export function decidePruneCandidate(input: PruneCandidateInput): PruneCandidateVerdict {
  const { candidate, followsUsNow } = input;
  if (isPruneWhitelisted(candidate, pruneWhitelistSet([...input.whitelist]))) {
    return { do: 'skip', pk: candidate.pk, reason: 'whitelisted' };
  }
  if (followsUsNow) return { do: 'skip', pk: candidate.pk, reason: 'followed-back' };
  if (candidate.username === null) {
    return { do: 'skip', pk: candidate.pk, reason: 'no-username' };
  }
  return { do: 'unfollow', pk: candidate.pk, username: candidate.username };
}

/**
 * The unvisited remainder of a run, from the candidate it stopped ON. Every
 * early exit (user stop, sentinel halt, cap truncation, an unexpected failure)
 * hands this back as the RUNNABLE set: a run that tapped out must never read as
 * "the list is clean", or the schedule resets and the next run re-walks both
 * lists. Total and pure — an out-of-range index yields an empty remainder.
 */
export function pruneRemainder<T>(candidates: readonly T[], index: number): readonly T[] {
  return candidates.slice(Math.max(0, index));
}
