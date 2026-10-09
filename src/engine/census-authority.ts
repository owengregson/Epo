/**
 * Which side of a prune census may turn ABSENCE into a verdict.
 *
 * A list walk reports completion and still misses rows: live 2026-08-31 the
 * following walk returned 2,928 of 3,329 accounts, "complete", and the census
 * declared 361 follows gone — which then re-entered the candidate pool as
 * accounts to follow. Completion is the walk's opinion; coverage of the profile
 * header's own count is the evidence. Each side answers for itself, and a side
 * with no header count to answer to proves nothing (PRINCIPLES §1: verdicts wait).
 */

import { POLICY } from '../kernel/policy';
import type { CensusAuthority } from '../store/repos/census';

const proven = (listed: number, known: number | null | undefined): boolean =>
  typeof known === 'number' && listed >= known * POLICY.CENSUS_ABSENCE_COVERAGE;

export function censusAuthority(
  listedFollowing: number,
  listedFollowers: number,
  header: { following?: number | null; followers?: number | null } | null,
): Exclude<CensusAuthority, boolean> {
  return {
    following: proven(listedFollowing, header?.following),
    followers: proven(listedFollowers, header?.followers),
  };
}
