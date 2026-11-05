/**
 * Which side of a prune census may turn ABSENCE into a verdict, and whether a census covers the
 * header it was taken against (spec §10.4). Completion is the walk's opinion; coverage of the
 * profile header's own count is the evidence, and a side that answers to no header proves nothing.
 */

import { CENSUS_POLICY } from '../kernel/census-policy';
import { POLICY } from '../kernel/policy';
import type { CensusAuthority } from '../store/repos/census';

/** Our own profile header, as one verified refresh read it. */
export interface OwnHeader {
  readonly followers: number;
  readonly following: number;
  readonly observedAt: number;
}

export type CoverageVerdict =
  | { ok: true; ghosts: number }
  | { ok: false; reason: 'header-unknown' | 'short' | 'row-issues'; scraped: number; known: number | null };

/**
 * Whether a census of `scraped` accounts covers the header's `known`: an unknown header fails
 * closed; a header below the floor passes (tiny accounts are ghost-dominated); a list short of the
 * coverage share fails; quarantined rows fail; otherwise the difference is ghosts.
 */
export function coverageVerdict(scraped: number, known: number | null, quarantined: number): CoverageVerdict {
  if (known === null) return { ok: false, reason: 'header-unknown', scraped, known };
  const ghosts = Math.max(0, known - scraped);
  if (known < CENSUS_POLICY.coverageFloor) return { ok: true, ghosts };
  if (scraped < known * CENSUS_POLICY.scanCoverageMin) return { ok: false, reason: 'short', scraped, known };
  if (quarantined > 0) return { ok: false, reason: 'row-issues', scraped, known };
  return { ok: true, ghosts };
}

const proven = (listed: number, known: number | null | undefined, quarantined: number): boolean =>
  quarantined === 0 && typeof known === 'number' && listed >= known * POLICY.CENSUS_ABSENCE_COVERAGE;

/**
 * A "complete" walk can still miss rows (a following walk once listed 2,928 of 3,329 and declared
 * 361 follows gone): each side must cover its own header count, and a side with unreadable rows
 * proves nothing (PRINCIPLES §1: verdicts wait).
 */
export function censusAuthority(
  listedFollowing: number,
  listedFollowers: number,
  header: { following?: number | null; followers?: number | null } | null,
  quarantined: { following: number; followers: number } = { following: 0, followers: 0 },
): Exclude<CensusAuthority, boolean> {
  return {
    following: proven(listedFollowing, header?.following, quarantined.following),
    followers: proven(listedFollowers, header?.followers, quarantined.followers),
  };
}
