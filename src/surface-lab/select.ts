/**
 * How the corpus CHOOSES what to keep.
 *
 * Two axes, one rule on each: a body is routed to the endpoint whose shape it
 * carries (the local capture files are named by a coarse capture-time
 * classification that predates the endpoint table), and the corpus keeps only
 * bodies and snapshots with DISTINCT shapes. Four followers pages that differ
 * only in which accounts they list regression-test one thing; a page without a
 * cursor and a menu row shipped as a bare span are each their own test.
 */

import type { Source } from '@/store/types';
import type { EndpointKind } from '@/surface/schema/endpoints';

/** Observation provenance for each endpoint kind. */
export const SOURCE_OF: Record<EndpointKind, Source> = {
  'followers-list': 'followers-list',
  'following-list': 'following-list',
  'friend-requests': 'friend-requests',
  'show-many': 'show-many',
  'friendship-show': 'show-many',
  'profile-info': 'profile',
  'profile-graphql': 'profile',
  'activity-feed': 'activity-feed',
};

/** Route a raw capture body to the endpoint whose shape it carries. */
export function classifyBody(name: string, body: unknown): EndpointKind | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const rec = body as Record<string, unknown>;
  if (Array.isArray(rec.users)) {
    // `friendships/pending/` carries the friendships-list shape PLUS the
    // requests container — the only way to tell them apart from the body alone.
    if (rec.friend_requests !== undefined) return 'friend-requests';
    return name.includes('following') ? 'following-list' : 'followers-list';
  }
  if (typeof rec.friendship_statuses === 'object' && rec.friendship_statuses !== null) {
    return 'show-many';
  }
  if (typeof rec.following === 'boolean' || typeof rec.followed_by === 'boolean') {
    return 'friendship-show';
  }
  // Both profile bodies carry a `user` record; only the container differs.
  if (typeof rec.data === 'object' && rec.data !== null && 'user' in (rec.data as object)) {
    return 'profile-graphql';
  }
  if ('user' in rec) return 'profile-info';
  if (Array.isArray(rec.new_stories) || Array.isArray(rec.old_stories)) return 'activity-feed';
  return null;
}

/**
 * Which BEHAVIOURS a DOM snapshot can exercise, as a signature. Doubles as the
 * snapshot's recorded provenance: it says what the file is FOR without naming
 * whose page it was.
 */
export function domFeatures(html: string): string {
  const has = (re: RegExp): string => (re.test(html) ? '1' : '0');
  const confirmText = /(Unfollow|Cancel [Rr]equest)</;
  return [
    // A confirm row shipped as a real <button> and one shipped as nested spans
    // inside a div[role=button] are DIFFERENT tests of the same control.
    `confirmButton:${has(new RegExp(`<button[^>]*>[^<]*${confirmText.source}`))}`,
    `confirmText:${has(confirmText)}`,
    `scroller:${has(/overflow/)}`,
    `action:${has(/>(\s*)(Following|Follow|Requested|Follow [Bb]ack)</)}`,
    `rows:${has(/href="\/[A-Za-z0-9._]+\/"/)}`,
    `stat:${has(/followers/i)}`,
  ].join(' ');
}

/** A body's key-set fingerprint — the axis the corpus is diversified along. */
export const fingerprint = (body: unknown): string =>
  typeof body === 'object' && body !== null && !Array.isArray(body)
    ? Object.keys(body as object).sort().join(',')
    : 'non-object';
