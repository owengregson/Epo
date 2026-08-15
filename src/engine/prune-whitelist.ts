/**
 * Prune whitelist matching — the ONE definition of "is this candidate
 * protected?", shared by the PruneEngine (which derives the actionable set and
 * skips protected candidates mid-run) and the renderer (which derives the
 * visible candidate list from the raw scan census). Pure and dependency-free
 * so both sides bundle it without dragging engine internals around.
 *
 * A whitelist entry matches case-insensitively against a candidate's username
 * OR its pk, mirroring the scan's historical semantics.
 */

import type { PruneCandidate } from './prune-engine';

/** Normalize a whitelist to a lowercase lookup set (blank entries dropped). */
export function pruneWhitelistSet(whitelist: string[]): Set<string> {
  return new Set(whitelist.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0));
}

/** Whether one candidate is protected by the (already-normalized) set. */
export function isPruneWhitelisted(cand: PruneCandidate, set: Set<string>): boolean {
  if (set.size === 0) return false;
  if (set.has(cand.pk.toLowerCase())) return true;
  return cand.username !== null && set.has(cand.username.toLowerCase());
}

/** The actionable subset of a raw candidate census under `whitelist`. */
export function filterPruneCandidates(
  candidates: PruneCandidate[],
  whitelist: string[],
): PruneCandidate[] {
  const set = pruneWhitelistSet(whitelist);
  if (set.size === 0) return candidates;
  return candidates.filter((c) => !isPruneWhitelisted(c, set));
}
