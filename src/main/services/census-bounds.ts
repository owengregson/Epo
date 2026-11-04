import type { PlanView } from '@/governors/plan-types';
import { censusFollowerPages, censusPagesMax } from '@/kernel/derive-reads';
import { EXPLORATION_POLICY } from '@/kernel/exploration-policy';
import { censusWalkMax } from '@/kernel/plan/reads';
import { BOUNDS_REENTRY } from '@/kernel/reentry-policy';

/** A census fits both lists in the open session; an over-bound header refuses before either list. */
export function censusBounds(view: PlanView, header: { followers: number | null }, rowsPerPage: number | null): {
  followers: number; following: number; walkMax: number;
} {
  const fallback = EXPLORATION_POLICY.rowsPerSlice / EXPLORATION_POLICY.pagesPerSlice;
  const capped = censusPagesMax(header, rowsPerPage, fallback);
  const followers = header.followers === null ? capped : Math.max(capped, censusFollowerPages(header.followers, rowsPerPage ?? fallback));
  const following = BOUNDS_REENTRY.FOLLOWING_WALK_PAGES;
  const session = view.open === null ? undefined : view.sessions[view.open.idx];
  const walkMax = censusWalkMax({ remainingMs: (session?.closesAt ?? view.at) - view.at, tempo: view.tempo });
  return { followers, following, walkMax };
}
