/**
 * The per-candidate prune decision as ONE pure function the run loop, the woven feed and the
 * prune-run mode rule share (P5–P7, P10). The caller supplies the readings and owns what a skip
 * consumes: a protected skip spends no actionable slot; a followed-back or no-username skip visits.
 */

import type { ProtectedBy, ProtectionVerdict } from '../shared/unfollow-protection';

/** A census row as both prune paths hold it. */
export interface PruneSubject {
  pk: string;
  username: string | null;
}

/** The live readings the decision needs; every one is supplied by the caller. */
export interface PruneCandidateInput {
  candidate: PruneSubject;
  /** The protection verdict over the stored facts as they stand NOW (rule 1). */
  protection: ProtectionVerdict;
  /** What the LIVE graph says about `candidate → us` right now (rule 2). */
  followsUsNow: boolean;
}

export type PruneSkipReason = 'protected' | 'followed-back' | 'no-username';

/** `unfollow` carries the username (no handle, no DOM action); `stop` ends the run without consuming. */
export type PruneCandidateVerdict =
  | { do: 'unfollow'; pk: string; username: string }
  | { do: 'skip'; pk: string; reason: PruneSkipReason }
  | { do: 'stop'; pk: string; reason: 'protection-paused' };

/**
 * In order: protection over the facts as they stand NOW (paused stops, protected skips, unknown goes
 * on to the click), the live graph's follows-us edge (PRINCIPLES §2), then the username.
 */
export function decidePruneCandidate(input: PruneCandidateInput): PruneCandidateVerdict {
  const { candidate, protection, followsUsNow } = input;
  if (protection.kind === 'paused') return { do: 'stop', pk: candidate.pk, reason: 'protection-paused' };
  if (protection.kind === 'protected') return { do: 'skip', pk: candidate.pk, reason: 'protected' };
  if (followsUsNow) return { do: 'skip', pk: candidate.pk, reason: 'followed-back' };
  if (candidate.username === null) {
    return { do: 'skip', pk: candidate.pk, reason: 'no-username' };
  }
  return { do: 'unfollow', pk: candidate.pk, username: candidate.username };
}

/** A census row as the candidates channel serves it: the rule that keeps it, and an unjudged bio. */
export type AnnotatedCandidate<T extends PruneSubject> = T & {
  readonly protectedBy: ProtectedBy | null;
  readonly bioUnread: boolean;
};

/** Annotate one row with its protection verdict (spec §7.8: "Show protected (N)"). */
export function annotateCandidate<T extends PruneSubject>(c: T, v: ProtectionVerdict): AnnotatedCandidate<T> {
  return { ...c, protectedBy: v.kind === 'protected' ? v.by : null, bioUnread: v.kind === 'unknown' && v.missing === 'bio' };
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
