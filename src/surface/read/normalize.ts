/**
 * Container resolution (spec §10.3): a definition's declared containers are tried canonical first;
 * the first present one whose record validates is read, an alternate as a normalized step. A
 * connection reads as a page: its rows, and its cursor and more-flag only where present.
 */

import { valueAt } from '@/surface/read/fields';
import type { ContainerDecl, ContinuationDecl } from '@/surface/schema/decls';
import type { NormalizeStep } from '@/surface/schema/projection';
import { type EndpointDef, flattenIssues } from '@/surface/schema/surface';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One candidate definition and its index in the document. */
export interface DefRef {
  readonly def: EndpointDef;
  readonly index: number;
}

export type Resolution =
  | { readonly kind: 'value'; readonly ref: DefRef; readonly value: unknown; readonly at: string; readonly steps: NormalizeStep[] }
  /** The container present and `null`: the definition's own "gone" answer. */
  | { readonly kind: 'null'; readonly ref: DefRef; readonly at: string; readonly steps: NormalizeStep[] }
  | { readonly kind: 'none'; readonly issues: Array<{ path: string; message: string }> };

/** A connection as the list page shape; a missing cursor or more-flag stays missing (spec §10.4). */
function pageOf(conn: Record<string, unknown>, c: NonNullable<ContainerDecl['connection']>, cont: ContinuationDecl):
  Record<string, unknown> | undefined {
  const edges = conn[c.edges];
  if (!Array.isArray(edges)) return undefined;
  const cursor = valueAt(conn, c.cursor);
  const more = valueAt(conn, c.hasNext);
  const flag = c.hasNext.split('.').pop() ?? c.hasNext;
  return {
    [cont.rowsKey]: edges.map((edge) => valueAt(edge, c.node)),
    ...(cursor === undefined || cursor === null ? {} : { [cont.cursorKeys[0] ?? c.cursor]: cursor }),
    ...(more === undefined ? {} : { [flag]: more }),
  };
}

/** Resolve the first declared container that is present and validates, across the candidate definitions. */
export function resolveContainer(defs: readonly DefRef[], json: unknown, cont: ContinuationDecl): Resolution {
  let first: Array<{ path: string; message: string }> | null = null;
  for (const ref of defs) {
    for (const [i, c] of ref.def.containers.entries()) {
      const steps: NormalizeStep[] = i === 0 ? [] : [{ kind: 'alternate-container', at: c.at === '' ? '(body)' : c.at }];
      const raw = valueAt(json, c.at);
      if (raw === null && c.absentWhenNull === true) return { kind: 'null', ref, at: c.at, steps };
      const value = c.kind === 'connection' && c.connection !== undefined
        ? (isRecord(raw) ? pageOf(raw, c.connection, cont) : undefined) : raw;
      if (!isRecord(value)) {
        first ??= [{ path: c.at === '' ? '(body)' : c.at, message: `no ${c.kind} at the declared container` }];
        continue;
      }
      const parsed = ref.def.response.safeParse(value);
      if (parsed.success) return { kind: 'value', ref, value: parsed.data, at: c.at, steps };
      first ??= flattenIssues(parsed.error.issues).map((x) => ({ path: c.at === '' ? x.path : `${c.at}.${x.path}`, message: x.message }));
    }
  }
  return { kind: 'none', issues: first ?? [{ path: '(body)', message: 'no definition reads this endpoint' }] };
}

/** The expected paths a record lacks: `x[]` walks every row and `*` every value; a null parent hides none. */
export function missingPaths(value: unknown, patterns: readonly string[]): string[] {
  return patterns.filter((p) => lacks(value, p.split('.')));
}

function lacks(v: unknown, segs: readonly string[]): boolean {
  const [head, ...rest] = segs;
  if (head === undefined || !isRecord(v)) return false;
  if (head === '*') return Object.values(v).some((child) => lacks(child, rest));
  const rows = head.endsWith('[]');
  const child = v[rows ? head.slice(0, head.length - '[]'.length) : head];
  if (child === undefined) return true;
  return rows ? Array.isArray(child) && child.some((row) => lacks(row, rest)) : lacks(child, rest);
}
