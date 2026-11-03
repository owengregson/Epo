/**
 * Field readers and invariants (spec §10.3, I1–I10): each scalar is read at a declared key and
 * returns a value, or a typed reason it has none. No reader ever coerces across kinds or guesses.
 */

import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { MS_PER_DAY, MS_PER_SECOND } from '@/kernel/units';
import type { NormalizeStep } from '@/surface/read/types';
import type { FieldIssue, JsonType, Presence } from '@/surface/schema/projection';

/** A version's id keys: the canonical key first, then its aliases; foreign ids are named so they never vote. */
export interface IdDecl {
  readonly idKeys: readonly string[];
  readonly foreignIdKeys: readonly string[];
}

/** A version's profile count keys. */
export interface CountKeys {
  readonly followers: string;
  readonly following: string;
  readonly mutuals: string;
}

export function jsonTypeOf(v: unknown): JsonType {
  if (v === undefined) return 'absent';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' ? t : 'object';
}

/** I1: a decimal id string with no leading zero, up to twenty digits. */
const DECIMAL_ID = /^[1-9]\d{0,19}$/;

type IdValue = { pk: string } | { kind: 'id-space' | 'unsafe-number' | 'invalid' };

function canonicalId(v: unknown): IdValue {
  if (typeof v === 'string') return DECIMAL_ID.test(v) ? { pk: v } : { kind: 'id-space' };
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? { pk: String(v) } : { kind: 'unsafe-number' };
  return { kind: 'invalid' };
}

/**
 * The record's id (I1, I2): the canonical key when present, else agreeing aliases (a normalized
 * step). Every present allow-listed key that canonicalizes must agree; one that does not is an
 * issue on the canonical key and never votes. Foreign ids are never read.
 */
export function readId(record: Record<string, unknown>, decl: IdDecl): { pk: string; step?: NormalizeStep } | { issue: FieldIssue } {
  const [canonicalKey, ...aliases] = decl.idKeys;
  const present = (key: string): boolean => record[key] !== undefined && record[key] !== null;
  const canonical = present(canonicalKey) ? canonicalId(record[canonicalKey]) : null;
  if (canonical !== null && 'kind' in canonical) {
    return { issue: { path: canonicalKey, kind: canonical.kind, got: jsonTypeOf(record[canonicalKey]) } };
  }
  let pk = canonical?.pk ?? null;
  let step: NormalizeStep | undefined;
  for (const key of aliases) {
    const alias = present(key) ? canonicalId(record[key]) : null;
    if (alias === null || 'kind' in alias) continue;
    if (pk === null) {
      pk = alias.pk;
      step = { kind: 'alias-key', at: key };
    } else if (alias.pk !== pk) {
      return { issue: { path: key, kind: 'id-conflict' } };
    }
  }
  if (pk === null) return { issue: { path: canonicalKey, kind: 'expected-absent', got: jsonTypeOf(record[canonicalKey]) } };
  return step === undefined ? { pk } : { pk, step };
}

type CountValue = { value: number; step?: NormalizeStep } | 'missing' | 'invalid';

function readCount(record: Record<string, unknown>, key: string): CountValue {
  const v = record[key];
  if (v === undefined || v === null) return 'missing';
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? { value: v } : 'invalid';
  if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) return 'invalid';
  return { value: Number(v), step: { kind: 'retype', at: key, detail: 'string' } };
}

/**
 * The counts (I5), read only at the declared keys as non-negative safe integers (a digit string
 * is a retype step). Followers and following are emitted as a pair, mutuals only alongside it;
 * a partial pair emits no stat. `null` when the record carries neither count.
 */
export function readCountPair(
  record: Record<string, unknown>,
  keys: CountKeys,
): { followers: number; following: number; mutuals?: number; steps: NormalizeStep[] } | { issue: FieldIssue } | null {
  const followers = readCount(record, keys.followers);
  const following = readCount(record, keys.following);
  if (followers === 'missing' && following === 'missing') return null;
  if (followers === 'invalid' || following === 'invalid') {
    const bad = followers === 'invalid' ? keys.followers : keys.following;
    return { issue: { path: bad, kind: 'invalid', got: jsonTypeOf(record[bad]) } };
  }
  if (followers === 'missing' || following === 'missing') {
    return { issue: { path: followers === 'missing' ? keys.followers : keys.following, kind: 'counts-partial' } };
  }
  const mutuals = readCount(record, keys.mutuals);
  const steps = [followers.step, following.step, typeof mutuals === 'object' ? mutuals.step : undefined]
    .filter((s): s is NormalizeStep => s !== undefined);
  return { followers: followers.value, following: following.value,
    ...(typeof mutuals === 'object' ? { mutuals: mutuals.value } : {}), steps };
}

/** A boolean at a declared key, or why there is none (never coerced from another kind). */
export function readBool(record: Record<string, unknown>, key: string): { value: boolean } | { presence: Presence } {
  const v = record[key];
  if (typeof v === 'boolean') return { value: v };
  return { presence: v === undefined ? 'absent' : v === null ? 'null' : 'invalid' };
}

/** A text field's presence: '' and text both read; an explicit null stays apart from absence. */
export function readTextPresence(record: Record<string, unknown>, key: string): Presence {
  const v = record[key];
  if (typeof v === 'string') return 'read';
  return v === undefined ? 'absent' : v === null ? 'null' : 'invalid';
}

/** I10: a null relationship is the viewer reading their own record only when the pks match. */
export function readRelationshipPresence(
  record: Record<string, unknown>,
  key: string,
  recordPk: string | null,
  viewerPk: string | null,
): Presence | 'self' {
  const v = record[key];
  if (v === null) return viewerPk !== null && viewerPk === recordPk ? 'self' : 'null';
  if (v === undefined) return 'absent';
  return typeof v === 'object' && !Array.isArray(v) ? 'read' : 'invalid';
}

/** I9: epoch seconds within [the time floor, now + one day] become ms; anything else is a unit or range error. */
export function readEpochSeconds(v: unknown, atMs: number, path = ''): { ms: number } | { issue: FieldIssue } {
  const ms = typeof v === 'number' && Number.isFinite(v) ? Math.round(v * MS_PER_SECOND) : Number.NaN;
  if (ms >= SURFACE_BOUNDS.timeFloorMs && ms <= atMs + MS_PER_DAY) return { ms };
  return { issue: { path, kind: 'time-range', got: jsonTypeOf(v) } };
}
