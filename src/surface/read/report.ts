/**
 * What a read tells the sink (spec §10.7): one tally with its issue counts, and one drift signal per
 * class and path pattern — never a value. Repeats are counted by the sink, not logged here.
 */

import type { ReadFailure, SurfaceRead } from '@/surface/read/types';
import type { EndpointKind } from '@/surface/schema/endpoints';
import type { FieldIssue } from '@/surface/schema/projection';
import type { DriftClass, DriftSignal, SurfaceSink } from '@/surface/sink';
import * as logger from '@/utils/logger';

/** Why a read is partial, when it is. */
export type PartialReason = 'graphql-partial' | 'incomplete-stream' | null;

/** The drift class a field issue reports under. */
const issueClass = (kind: FieldIssue['kind']): DriftClass =>
  kind === 'expected-absent' || kind === 'unexpected-null' || kind === 'enum-novel' ? kind : 'row-issue';

/** The one signal a failed read raises (a 404 is an answer, not drift). */
function failureSignal(read: ReadFailure & { endpoint: EndpointKind }, sample: () => unknown): DriftSignal | null {
  const base = { endpoint: read.endpoint, sample } as const;
  switch (read.kind) {
    case 'wall': return { ...base, cls: 'wall', path: '(body)', detail: { family: read.family, via: read.via, status: read.status } };
    case 'http-absent': return null;
    case 'not-data': return { ...base, cls: 'transport', path: '(body)', detail: { status: read.status, mime: read.mime } };
    case 'transport': return { ...base, cls: 'transport', path: '(body)', detail: { reason: read.reason } };
    case 'mismatch':
      return { ...base, cls: 'mismatch', path: read.issues[0]?.path ?? '(body)', detail: { issues: read.issues.length, keys: read.keys.join(',') } };
    case 'ambiguous': return { ...base, cls: 'ambiguous', path: '(body)', detail: { candidates: read.candidates } };
    case 'rows-unreadable':
      return { ...base, cls: 'rows-unreadable', path: '(rows)', detail: { rows: read.rows, quarantined: read.quarantined } };
  }
}

/** The signals an admitted read raises: its steps, field and row issues, continuation drift, partial and new keys. */
function readSignals(read: Extract<SurfaceRead, { ok: true }>, partial: PartialReason, novelty: readonly string[],
  sample: () => unknown): DriftSignal[] {
  const endpoint = read.endpoint;
  const p = read.projection;
  const out: DriftSignal[] = read.steps.map((s) => ({ endpoint, cls: 'normalized', path: s.at,
    detail: { step: s.kind, ...(s.detail === undefined ? {} : { detail: s.detail }) } }));
  const seen = new Set<string>();
  for (const issue of p.fieldIssues) {
    const key = `${issue.kind}|${issue.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ endpoint, cls: issueClass(issue.kind), path: issue.path, detail: { kind: issue.kind, got: issue.got ?? null }, sample });
  }
  const first = p.rowIssues[0];
  if (first !== undefined) out.push({ endpoint, cls: 'row-issue', path: first.path, detail: { rows: p.rowIssues.length }, sample });
  const cont = p.continuation;
  if (cont?.kind === 'drift') out.push({ endpoint, cls: cont.reason, path: cont.key ?? '(page)', detail: {}, sample });
  if (partial !== null && cont?.kind !== 'drift') out.push({ endpoint, cls: partial, path: '(body)', detail: {} });
  for (const key of read.novelKeys) if (!novelty.includes(key)) out.push({ endpoint, cls: 'novel-key', path: key, detail: {} });
  if (read.located !== undefined) {
    out.push({ endpoint, cls: 'recovered', path: read.located.pattern, detail: { via: read.located.via, role: read.located.role }, sample });
  }
  return out;
}

/** Report one read; a sink that fails is logged, never thrown into the read path. */
export function reportRead(read: SurfaceRead, at: number, sink: SurfaceSink, opts: {
  readonly partial: PartialReason; readonly novelty: readonly string[]; readonly sample: () => unknown;
  readonly hint?: DriftSignal['hint'];
}): void {
  try {
    if (!read.ok) {
      sink.read(read.endpoint, read.kind === 'wall' ? 'wall' : 'failed',
        { rows: read.kind === 'rows-unreadable' ? read.quarantined : 0, fields: 0 }, at);
      const signal = failureSignal(read, opts.sample);
      if (signal !== null) sink.drift(signal, at);
      return;
    }
    sink.read(read.endpoint, read.tier, { rows: read.projection.rowIssues.length, fields: read.projection.fieldIssues.length }, at);
    for (const signal of readSignals(read, opts.partial, opts.novelty, opts.sample)) {
      sink.drift(signal.cls === 'recovered' && opts.hint !== undefined ? { ...signal, hint: opts.hint } : signal, at);
    }
  } catch (e) {
    logger.warn('surface.read: the sink refused a report', { endpoint: read.endpoint, error: String(e) });
  }
}
