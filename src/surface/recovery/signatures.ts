/**
 * What a located value must be, per recovery role (spec §10.6): user rows (I1–I3), the anchored
 * profile (I4), story sections, requester rows (I8), and the one-field username rule. Pure: the
 * version's keys arrive in its RecoveryDecl, and the witness (anchor, arm) in the caller's input.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { readCountPair, readId, valueAt } from '@/surface/read/fields';
import type { Anchor, Arm } from '@/surface/read/types';
import type { RecoveryRole } from '@/surface/recovery/hints';
import type { RecoveryDecl } from '@/surface/schema/decls';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The arm each role's witness needs, and whether it needs an anchor username or pk. */
export const ROLE_WITNESS: Readonly<Record<RecoveryRole, { readonly arm: Arm; readonly anchor: 'username' | 'pk' | null }>> = {
  'profile-user': { arm: 'visit', anchor: 'username' },
  'username-field': { arm: 'visit', anchor: 'username' },
  'feed-stories': { arm: 'drawer', anchor: null },
  'request-rows': { arm: 'requests-panel', anchor: null },
  'source-rows': { arm: 'acquisition', anchor: 'pk' },
};

/** I1 + I3: an allow-listed, agreeing id and a valid username. */
export function userRow(v: unknown, decl: RecoveryDecl): { pk: string; username: string } | null {
  if (!isRecord(v)) return null;
  const id = readId(v, decl);
  const handle = v[decl.handleKey];
  if ('issue' in id || typeof handle !== 'string' || !decl.handleRe.test(handle)) return null;
  return { pk: id.pk, username: handle };
}

/** I8: a C2 requester row carries `true` at the declared marker (a pending request to us). */
export const requesterRow = (v: unknown, decl: RecoveryDecl): boolean =>
  userRow(v, decl) !== null && valueAt(v, decl.requesterMarker) === true;

/** A story row: a record with a story type and an args record. */
export const storyRow = (v: unknown, decl: RecoveryDecl): boolean =>
  isRecord(v) && (typeof v[decl.storyTypeKey] === 'number' || typeof v[decl.storyTypeKey] === 'string')
  && isRecord(v[decl.storyArgsKey]);

/** I4: the anchor's own record — its username (and pk when known) and both counts valid. */
export function anchoredProfile(v: unknown, anchor: Anchor, decl: RecoveryDecl): boolean {
  const row = userRow(v, decl);
  if (row === null || anchor.username === undefined || !same(row.username, anchor.username)) return false;
  if (anchor.pk !== undefined && row.pk !== anchor.pk) return false;
  const pair = readCountPair(v as Record<string, unknown>, decl.profileCountKeys);
  return pair !== null && !('issue' in pair);
}

/**
 * R5: an array whose sampled elements are rows by a majority; an empty array never matches. A row
 * wrapped in a connection edge is read through its declared node key.
 */
export function rowsOf(v: unknown, decl: RecoveryDecl, row: (r: unknown) => boolean): unknown[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const unwrap = (r: unknown): unknown => (isRecord(r) && isRecord(r[decl.edgeNodeKey]) ? r[decl.edgeNodeKey] : r);
  const rows = v.map(unwrap);
  const sample = rows.slice(0, SURFACE_BOUNDS.sampleRows);
  return sample.filter(row).length >= SURFACE_BOUNDS.rowMajority * sample.length ? rows : null;
}

/** A story section container: a record whose declared sections hold story rows (at least one non-empty). */
export function storySections(v: unknown, decl: RecoveryDecl): boolean {
  if (!isRecord(v)) return false;
  const sections = decl.storySections.map((k) => v[k]).filter((s): s is unknown[] => Array.isArray(s));
  return sections.length > 0 && sections.some((s) => rowsOf(s, decl, (r) => storyRow(r, decl)) !== null)
    && sections.every((s) => s.length === 0 || rowsOf(s, decl, (r) => storyRow(r, decl)) !== null);
}

/** The username-field role: exactly one top-level string field equals the anchor's username, or null. */
export function usernameFieldOf(record: Record<string, unknown>, anchor: Anchor): string | null {
  if (anchor.username === undefined) return null;
  const hits = Object.entries(record).filter(([, v]) => typeof v === 'string' && same(v, anchor.username as string));
  return hits.length === 1 ? (hits[0]?.[0] ?? null) : null;
}
