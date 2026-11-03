/**
 * A body's corpus fingerprint (spec §10.8): its sorted key paths to the novelty depth (array elements merged,
 * a null told apart from an object) plus per-endpoint facets — the axes the corpus diversifies along. It reads
 * a raw body locally and returns key names and facet labels only, never a value.
 */

import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { CORPUS_PATHS } from '@/surface/versions/2026-08-12/scrub-shapes';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The value at a dotted path, or `undefined`. */
export function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Sorted dotted key paths to the novelty depth; `[]` marks array elements, `=null` a key holding null. */
export function keyPaths(value: unknown, depth: number = SURFACE_BOUNDS.noveltyMaxDepth): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, prefix: string, d: number): void => {
    if (d > depth) return;
    if (Array.isArray(v)) {
      for (const element of v) walk(element, `${prefix}[]`, d + 1);
      return;
    }
    if (!isRecord(v)) return;
    for (const [key, child] of Object.entries(v)) {
      // A digit-only key is data (a pk-keyed map), never shape.
      const path = `${prefix === '' ? '' : `${prefix}.`}${/^\d+$/.test(key) ? '*' : key}`;
      out.add(child === null ? `${path}=null` : path);
      walk(child, path, d + 1);
    }
  };
  walk(value, '', 0);
  return [...out].sort();
}

/** How many rows a body carries in its declared row containers. */
export function rowCount(kind: EndpointKind, body: unknown): number {
  let rows = 0;
  for (const path of CORPUS_PATHS.rows[kind] ?? []) {
    const found = at(body, path);
    if (Array.isArray(found)) rows += found.length;
  }
  return rows;
}

/** none / some (fits the kept rows) / many (trimmed on ingestion). */
const bucket = (rows: number): string => (rows === 0 ? 'none' : rows <= SCRUB_POLICY.rowsKept ? 'some' : 'many');

/** The facets of spec §10.8: what a profile, a feed or a requests body can exercise beyond its keys. */
export function facets(kind: EndpointKind, body: unknown, variables: unknown): string[] {
  switch (kind) {
    case 'profile-graphql': {
      const relationship = at(body, CORPUS_PATHS.profileRelationship);
      return [
        `relationship:${relationship === null ? 'self' : typeof relationship}`,
        `private:${String(at(body, CORPUS_PATHS.profilePrivate))}`,
        `mutuals:${at(body, CORPUS_PATHS.profileMutuals) === null ? 'null' : 'number'}`,
      ];
    }
    case 'activity-feed': {
      const types = new Set<string>();
      for (const path of CORPUS_PATHS.rows[kind] ?? []) {
        const stories = at(body, path);
        if (Array.isArray(stories)) for (const s of stories) types.add(String(at(s, CORPUS_PATHS.storyType)));
      }
      const filtered = isRecord(variables) && CORPUS_PATHS.feedFilter in variables;
      return [`types:${[...types].sort().join('+')}`, `events:${bucket(rowCount(kind, body))}`, `filtered:${filtered}`];
    }
    case 'friend-requests':
      return [`rows:${bucket(rowCount(kind, body))}`, `next:${String(at(body, CORPUS_PATHS.requestsHasNext))}`];
    default:
      return [];
  }
}

/** The fingerprint the corpus keeps one body per. */
export const fingerprintOf = (kind: EndpointKind, body: unknown, variables: unknown): string =>
  `${keyPaths(body).join(',')}|${facets(kind, body, variables).join(' ')}`;
