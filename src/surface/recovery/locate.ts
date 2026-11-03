/**
 * The bounded structural search (spec §10.6, R1–R7): find the one place in a decoded body that holds
 * a role's record or rows. Bounded (R1), decoy containers skipped (R2), witnessed (R3), exactly one
 * distinct pattern (R4), row majority (R5), hints first (R6), identity continuity (R7). Pure.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import type { Anchor, Arm } from '@/surface/read/types';
import type { IdentityOracle, RecoveryRole } from '@/surface/recovery/hints';
import { anchoredProfile, ROLE_WITNESS, requesterRow, rowsOf, storySections, userRow } from '@/surface/recovery/signatures';
import type { RecoveryDecl } from '@/surface/schema/decls';
import type { EndpointKind } from '@/surface/schema/endpoints';

export interface LocateInput {
  readonly role: RecoveryRole;
  readonly endpoint: EndpointKind;
  readonly body: unknown;
  readonly bodyBytes: number;
  readonly anchor?: Anchor;
  readonly arm?: Arm;
  readonly decl: RecoveryDecl;
  readonly hints: readonly string[];
  readonly identity?: IdentityOracle;
}

export type Located =
  | { readonly ok: true; readonly path: string; readonly pattern: string; readonly via: 'hint' | 'search';
      readonly value: unknown; readonly contradictedHint?: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'ambiguous' | 'anchor-required' | 'arm-required'
      | 'identity-conflict' | 'budget' | 'too-large'; readonly candidates: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (reason: Extract<Located, { ok: false }>['reason'], candidates = 0): Located => ({ ok: false, reason, candidates });

/** The value a role locates at `v`, or null: a record for the profile and the feed, the rows for the lists. */
function matchAt(v: unknown, input: LocateInput): unknown {
  const { decl, anchor } = input;
  switch (input.role) {
    case 'profile-user':
      return anchor !== undefined && anchoredProfile(v, anchor, decl) ? v : null;
    case 'username-field':
      return null; // read on the found record itself (`usernameFieldOf`), never searched
    case 'feed-stories':
      return storySections(v, decl) ? v : null;
    case 'request-rows':
      return rowsOf(v, decl, (r) => requesterRow(r, decl));
    case 'source-rows':
      return rowsOf(v, decl, (r) => userRow(r, decl) !== null);
  }
}

/** A key that is an id renders as `*` in a pattern, so no id ever enters a path (R1). */
const ID_KEY = /^[1-9]\d{0,19}$/;
const keySeg = (k: string): string => (ID_KEY.test(k) ? '*' : k);

/** Every value at a pattern (`[]` spans an array's elements, `*` an id-keyed map's values). */
function valuesAt(v: unknown, segs: readonly string[]): unknown[] {
  const [head, ...rest] = segs;
  if (head === undefined) return [v];
  if (head === '[]') return Array.isArray(v) ? v.flatMap((e) => valuesAt(e, rest)) : [];
  if (head === '*') return isRecord(v) ? Object.entries(v).filter(([k]) => ID_KEY.test(k)).flatMap(([, c]) => valuesAt(c, rest)) : [];
  return isRecord(v) && Object.hasOwn(v, head) ? valuesAt(v[head], rest) : [];
}

const patternSegs = (pattern: string): string[] => (pattern === '' ? [] : pattern.replace(/\[\]/g, '.[]').split('.').filter((s) => s !== ''));

/** R7: of recovered rows the store knows, the share under another username stays small (renames are legitimate). */
function identityHolds(value: unknown, input: LocateInput): boolean {
  if (input.identity === undefined || (input.role !== 'request-rows' && input.role !== 'source-rows')) return true;
  const rows = (Array.isArray(value) ? value : [value]).map((r) => userRow(r, input.decl)).filter((r) => r !== null);
  const known = rows.filter((r) => input.identity?.usernameOf(r.pk) !== undefined);
  const conflicts = known.filter((r) => input.identity?.usernameOf(r.pk)?.toLowerCase() !== r.username.toLowerCase());
  return conflicts.length <= SURFACE_BOUNDS.identityConflictMax * known.length;
}

interface Hit { readonly path: string; readonly pattern: string; readonly value: unknown }

/**
 * Walk the body breadth-first within the node and depth budget, skipping decoys; `null` when the budget
 * ran out. `handles` collects the pks of every record carrying the anchor's username (I4).
 */
function search(input: LocateInput, handles: Set<string>): Hit[] | null {
  const decoys = new Set(input.decl.foreignContainers[input.endpoint] ?? []);
  const anchorName = input.role === 'profile-user' ? input.anchor?.username?.toLowerCase() : undefined;
  const hits: Hit[] = [];
  const queue: Array<{ v: unknown; path: string; pattern: string; depth: number }> = [{ v: input.body, path: '', pattern: '', depth: 0 }];
  let nodes = 0;
  for (let i = 0; i < queue.length; i++) {
    const { v, path, pattern, depth } = queue[i] as (typeof queue)[number];
    if (++nodes > SURFACE_BOUNDS.searchMaxNodes) return null;
    if (decoys.has(pattern)) continue;
    const row = anchorName === undefined ? null : userRow(v, input.decl);
    if (row !== null && row.username.toLowerCase() === anchorName) handles.add(row.pk);
    const value = matchAt(v, input);
    if (value !== null) {
      hits.push({ path, pattern, value });
      continue;
    }
    if (depth >= SURFACE_BOUNDS.searchMaxDepth) continue;
    const join = (k: string): string => (pattern === '' ? keySeg(k) : `${pattern}.${keySeg(k)}`);
    if (Array.isArray(v)) {
      for (const [n, e] of v.slice(0, SURFACE_BOUNDS.sampleRows).entries()) {
        queue.push({ v: e, path: `${path}[${n}]`, pattern: `${pattern}[]`, depth: depth + 1 });
      }
    } else if (isRecord(v)) {
      for (const [k, child] of Object.entries(v)) queue.push({ v: child, path: path === '' ? k : `${path}.${k}`, pattern: join(k), depth: depth + 1 });
    }
  }
  return hits;
}

/** Locate the role's value in the body, or say why not. */
export function locate(input: LocateInput): Located {
  if (input.bodyBytes > SURFACE_BOUNDS.searchMaxBytes) return fail('too-large');
  const witness = ROLE_WITNESS[input.role];
  if (input.arm !== witness.arm) return fail('arm-required');
  if (witness.anchor !== null && input.anchor?.[witness.anchor] === undefined) return fail('anchor-required');
  let contradictedHint: string | undefined;
  for (const pattern of input.hints) {
    const at = valuesAt(input.body, patternSegs(pattern));
    const found = at.map((v) => matchAt(v, input)).filter((v) => v !== null);
    if (found.length === 1 && identityHolds(found[0], input)) return { ok: true, path: pattern, pattern, via: 'hint', value: found[0] };
    // A learned place that still exists but no longer holds the value contradicts the hint.
    if (at.length > 0) contradictedHint ??= pattern;
  }
  const handles = new Set<string>();
  const hits = search(input, handles);
  if (hits === null) return fail('budget');
  const patterns = new Set(hits.map((h) => h.pattern));
  if (hits.length === 0) return fail('not-found');
  // R4: one distinct place, and (for a profile) one record there.
  if (patterns.size > 1 || (input.role === 'profile-user' && hits.length > 1)) return fail('ambiguous', hits.length);
  const hit = hits[0] as Hit;
  // I4: another record under the anchor's username with a different id is someone else's copy, never the anchor.
  if (handles.size > 1 || !identityHolds(hit.value, input)) return fail('identity-conflict', hits.length);
  return { ok: true, path: hit.path, pattern: hit.pattern, via: 'search', value: hit.value,
    ...(contradictedHint === undefined ? {} : { contradictedHint }) };
}
