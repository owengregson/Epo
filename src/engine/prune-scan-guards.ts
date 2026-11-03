/**
 * The prune scan's census guards: a whole-list walk must verify completion and
 * cover the known list size before its census may drive any unfollow.
 */

import * as log from '../utils/logger';
import type { PruneScanFetch } from './prune-types';

/**
 * Throw when a whole-list walk did not verify genuine completion. The walk's
 * `complete` flag is computed with care (end-of-list claims are probed one
 * page past the end) and is the ONLY trustworthy census signal — the header
 * count can be unknown (a failed own-stats refresh) exactly when throttling
 * is also truncating walks, which is when a partial census is most dangerous.
 */
export function assertFetchComplete(phase: 'following' | 'followers', fetch: PruneScanFetch): void {
  if (fetch.complete) return;
  // Shape drift gets its own honest, user-facing wording: the walk fetched
  // pages Instagram no longer serves in a shape this build can read, so the
  // scan FAILS (the previous complete census is restored by the caller) —
  // never a completed empty census that would mark every follower "lost".
  if (fetch.reason === 'shape-mismatch') {
    throw new Error(
      `prune: ${phase} walk incomplete (shape-mismatch) — ` +
        "Instagram's interface appears to have changed; check for an Epo update. " +
        'The scan failed and the previous census is retained.',
    );
  }
  throw new Error(
    `prune: ${phase} walk incomplete (${fetch.reason}, ${fetch.pks.length} pks) — ` +
      'aborting so a partial census never drives unfollows',
  );
}

/**
 * Throw when a whole-list scrape covered too little of the known list size.
 * `known` comes from our own profile header (observed during this very scan);
 * null/small values skip the check — tiny accounts and ghost-follower drift
 * make exact matches meaningless, so the guard only catches gross truncation
 * (e.g. 38 scraped of ~3200 known). 85% margin: the header count runs a
 * little ahead of the real list (deactivated/deleted accounts stay counted).
 */
export function assertScanCoverage(phase: 'following' | 'followers', scraped: number, known: number | null): void {
  if (known === null || known < 50) return;
  if (scraped >= known * 0.85) {
    // A complete walk that still lands under the header figure is GHOSTS:
    // deactivated/deleted accounts stay in the profile count but Instagram
    // never returns them in the list — the scraped list is the real one.
    if (scraped < known) {
      log.info('prune: scraped list below header count (deactivated-account ghosts)', {
        phase,
        scraped,
        known,
        ghosts: known - scraped,
      });
    }
    return;
  }
  throw new Error(
    `prune: ${phase} scan incomplete — scraped ${scraped} of ~${known} known; ` +
      'aborting so a partial census never drives unfollows',
  );
}
