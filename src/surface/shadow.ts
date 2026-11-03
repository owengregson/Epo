/**
 * The shadow comparison (spec §10.3): two projections of one body, compared FIELD BY FIELD. Before
 * an endpoint's flip the document runs beside the legacy extractor; after it the legacy extractor
 * runs beside the document. A disagreement is reported as `shadow-disagreed`; behaviour never changes.
 */

import type { Observation } from '@/store/types';
import type { SurfaceRead } from '@/surface/read/types';
import type { Projection } from '@/surface/schema/projection';
import type { SurfaceSink } from '@/surface/sink';
import * as logger from '@/utils/logger';

/** The projected fields a comparison reads; a legacy result fills what it carries. */
export type Comparable = Pick<Projection, 'facts' | 'relationships' | 'events' | 'cursor' | 'hasMore' | 'absent'>
  & Partial<Pick<Projection, 'continuation' | 'presence' | 'pendingPreview'>> & { readonly rows?: number };

const FACT_FIELDS = ['username', 'followers', 'following', 'mutuals', 'isPrivate', 'isVerified', 'bio'] as const;
const REL_FIELDS = ['pk', 'following', 'outgoingRequest', 'followedBy', 'incomingRequest', 'isPrivate'] as const;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function factDiffs(name: string, a: readonly Observation[], b: readonly Observation[], out: string[]): void {
  if (a.length !== b.length) out.push(`${name}.length`);
  a.forEach((fa, i) => {
    const fb = b[i];
    if (fb === undefined) return;
    if (fa.accountPk !== fb.accountPk) out.push(`${name}[].accountPk`);
    for (const f of FACT_FIELDS) if (!same(fa.fields[f], fb.fields[f])) out.push(`${name}[].fields.${f}`);
  });
}

/** Every field the two disagree on, as path patterns (empty when they agree); `rows` compares unread rows. */
export function diffProjections(doc: Comparable, legacy: Comparable): string[] {
  const out: string[] = [];
  factDiffs('facts', doc.facts, legacy.facts, out);
  if (doc.relationships.length !== legacy.relationships.length) out.push('relationships.length');
  doc.relationships.forEach((r, i) => {
    const l = legacy.relationships[i];
    if (l !== undefined) for (const f of REL_FIELDS) if (!same(r[f], l[f])) out.push(`relationships[].${f}`);
  });
  if (doc.events.length !== legacy.events.length) out.push('events.length');
  doc.events.forEach((e, i) => {
    const l = legacy.events[i];
    if (l !== undefined && !same(e, l)) out.push('events[]');
  });
  for (const key of ['cursor', 'hasMore', 'absent'] as const) if (!same(doc[key], legacy[key])) out.push(key);
  if (legacy.continuation !== undefined && !same(doc.continuation, legacy.continuation)) out.push('continuation');
  if (legacy.presence !== undefined && !same(doc.presence, legacy.presence)) out.push('presence');
  if (legacy.pendingPreview !== undefined) factDiffs('pendingPreview', doc.pendingPreview ?? [], legacy.pendingPreview, out);
  if (legacy.rows !== undefined && doc.rows !== legacy.rows) out.push('rows');
  return [...new Set(out)];
}

/** A read's projection as a comparable, or `null` when the read failed. */
export const comparableOf = (read: SurfaceRead): Comparable | null =>
  read.ok ? { ...read.projection, rows: read.projection.rowIssues.length } : null;

/** Report a comparison: `shadow-disagreed` once per differing field, or nothing when the two agree. */
export function reportShadow(sink: SurfaceSink, read: SurfaceRead, diffs: readonly string[], at: number): void {
  if (diffs.length === 0) return;
  try {
    sink.read(read.endpoint, 'shadow-disagreed', { rows: 0, fields: diffs.length }, at);
    for (const path of diffs) sink.drift({ endpoint: read.endpoint, cls: 'shadow-disagreed', path, detail: { fields: diffs.length } }, at);
  } catch (e) {
    logger.warn('surface.shadow: the sink refused a report', { endpoint: read.endpoint, error: String(e) });
  }
}
