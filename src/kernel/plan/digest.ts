/**
 * The intent digest (spec §5.3): FNV-1a over the canonical JSON of a `PlanIntent` (keys sorted at
 * every depth), so the same intent always digests the same and any change in meaning redigests.
 * Bookkeeping never re-plans: only a digest change is a `settings` cause.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { fnv1a } from '../rng';
import type { PlanIntent } from './types';

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The intent's digest: 8 hex digits of FNV-1a over its canonical JSON. */
export function intentDigest(intent: PlanIntent): string {
  return fnv1a(canonicalJson(intent)).toString(16).padStart(8, '0');
}
