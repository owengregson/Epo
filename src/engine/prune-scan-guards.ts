/**
 * The prune scan's census guards: a whole-list walk must verify completion, read every row and
 * cover the known list size before its census may drive any unfollow (spec §10.4).
 */

import * as log from '../utils/logger';
import { coverageVerdict } from './census-authority';
import type { PruneScanFetch } from './prune-types';

/**
 * Throw when a whole-list walk did not verify genuine completion, or skipped rows it could not
 * read. The walk's `complete` flag is the ONLY trustworthy census signal; a quarantined row is an
 * account the census cannot see, which would turn a real follower into an unfollow candidate.
 */
export function assertFetchComplete(phase: 'following' | 'followers', fetch: PruneScanFetch): void {
  if ((fetch.quarantined ?? 0) > 0) {
    throw new Error(
      `prune: ${phase} walk read ${fetch.quarantined} rows it could not parse (row-issues) — ` +
        "Instagram's interface appears to have changed; check for an Epo update. " +
        'The scan failed and the previous census is retained.',
    );
  }
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
 * Throw unless a whole-list scrape covers the header it was taken against (`coverageVerdict`).
 * An unknown header fails closed whenever the scan refreshed it (`headerRequired`); a scan with no
 * refresh wired has no header to answer to. Within the margin, the difference is ghosts.
 */
export function assertScanCoverage(
  phase: 'following' | 'followers',
  scraped: number,
  known: number | null,
  opts: { quarantined?: number; headerRequired?: boolean } = {},
): void {
  const verdict = coverageVerdict(scraped, known, opts.quarantined ?? 0);
  if (verdict.ok) {
    // Deactivated/deleted accounts stay in the profile count but never appear in the list.
    if (verdict.ghosts > 0) log.info('prune: scraped list below header count (deactivated-account ghosts)', {
      phase, scraped, known, ghosts: verdict.ghosts });
    return;
  }
  const what = phase === 'followers' ? 'follower' : 'following';
  if (verdict.reason === 'header-unknown') {
    if (!opts.headerRequired) return;
    throw new Error(`prune: ${phase} header unknown — Couldn't confirm your ${what} count, so this prune waits until it can be read.`);
  }
  if (verdict.reason === 'row-issues') {
    throw new Error(`prune: ${phase} census has unreadable rows (row-issues) — aborting so an unreadable account never becomes a candidate`);
  }
  throw new Error(
    `prune: ${phase} scan incomplete — scraped ${scraped} of ~${known} known; ` +
      'aborting so a partial census never drives unfollows',
  );
}
