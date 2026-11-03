/**
 * The structural leak rules (spec §10.7–§10.8): the shapes identity takes in text — an Instagram media URL,
 * a URL off the placeholder host, a cookie or token name, a long opaque token, an @handle or a profile href
 * that is not a pseudonym, a long digit run outside the synthetic ranges. They need no originals, so the
 * corpus leak test and the production sink's sample check run the same rules on any text.
 */

import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SCRUBBED_URL_HOST } from '@/surface/lab/scrub-dom';
import { RESERVED_ROUTES } from '@/surface/versions/2026-08-12/literals';

export type LeakRule =
  | 'media-url'
  | 'foreign-url'
  | 'cookie-name'
  | 'opaque-token'
  | 'handle-mention'
  | 'handle-href'
  | 'id-run';

/** What a scrubbed handle looks like. */
export const PSEUDO_HANDLE = /^user_[a-z]\d+$/;

const MEDIA = /cdninstagram\.com|fbcdn\.net|scontent[-.]/i;
const URL_RE = /https?:\/\/[^\s"'()<>\\]+/g;
const COOKIE = /\b(sessionid|csrftoken|ds_user_id|mid|ig_did|rur|shbid|shbts|authorization|bearer|x-ig-www-claim)\b/i;
/** A long run of token characters carrying a digit: the shape a session cookie or signed token takes. */
const OPAQUE = /\b(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{40,}\b/;
const MENTION = /@([A-Za-z0-9._]{2,30})/g;
const HREF = /href="\/([A-Za-z0-9._]{1,30})(?:\/[^"]*)?"/g;
const DIGIT_RUN = /\d{8,}/g;

const PK_DIGITS = String(SCRUB_POLICY.syntheticPkBase).length;
const TIME_DIGITS = String(SCRUB_POLICY.syntheticTimeBase).length;

/** Whether a long digit run is one a scrubber mints: a synthetic id, a shifted time, or an allowed constant. */
export function isSyntheticRun(run: string, allowed: readonly string[] = []): boolean {
  if (allowed.includes(run)) return true;
  const n = Number(run);
  const { syntheticPkBase, syntheticPkSpan, syntheticTimeBase, syntheticTimeSpan } = SCRUB_POLICY;
  if (run.length === PK_DIGITS && n >= syntheticPkBase && n < syntheticPkBase + syntheticPkSpan) return true;
  return run.length === TIME_DIGITS && n >= syntheticTimeBase && n < syntheticTimeBase + syntheticTimeSpan;
}

/** Every rule `text` breaks, in rule order; `allowedRuns` lists the long constants a corpus may stamp. */
export function structuralLeaks(text: string, allowedRuns: readonly string[] = []): LeakRule[] {
  const broken = new Set<LeakRule>();
  if (MEDIA.test(text)) broken.add('media-url');
  for (const url of text.match(URL_RE) ?? []) {
    if (!url.startsWith(SCRUBBED_URL_HOST)) broken.add('foreign-url');
  }
  if (COOKIE.test(text)) broken.add('cookie-name');
  if (OPAQUE.test(text)) broken.add('opaque-token');
  for (const m of text.matchAll(MENTION)) {
    if (!PSEUDO_HANDLE.test(m[1] ?? '')) broken.add('handle-mention');
  }
  for (const m of text.matchAll(HREF)) {
    const handle = m[1] ?? '';
    if (handle !== '' && !RESERVED_ROUTES.has(handle.toLowerCase()) && !PSEUDO_HANDLE.test(handle)) {
      broken.add('handle-href');
    }
  }
  for (const run of text.match(DIGIT_RUN) ?? []) {
    if (!isSyntheticRun(run, allowedRuns)) broken.add('id-run');
  }
  const order: readonly LeakRule[] = [
    'media-url', 'foreign-url', 'cookie-name', 'opaque-token', 'handle-mention', 'handle-href', 'id-run',
  ];
  return order.filter((rule) => broken.has(rule));
}
