/**
 * Parse, don't validate — the boundary between untrusted bytes and facts.
 *
 * `SHAPE_MISMATCH` (ADR 0303) is the right idea with no evidence: it is a bare
 * `Symbol`, so a drifted followers page tells you nothing about WHICH path moved,
 * and each version module hand-writes ~10 early returns where one missed branch
 * fabricates an empty list. A schema has exactly two exits, and this module
 * names them:
 *
 *   1. There is no third case. `Parsed<T>` is a value or a drift.
 *   2. Empty is a VALUE; drift is not. `z.array(user)` accepts `[]` and rejects
 *      `{}` — the distinction ADR 0303 protects becomes the parser's definition
 *      rather than a reviewer's vigilance.
 *   3. Drift is diagnosable: `drift.at` is the JSON path, which is what gets
 *      written into `src/adapter/versions/<new-date>.ts`.
 *
 * `parseWith` NEVER throws — not for a malformed body, not for a schema whose
 * refinement blows up. That is the property, not a convention. See ADR 0604.
 *
 * NOT for Settings: settings semantics are coercion to the nearest safe value,
 * never rejection (ADR 0103). The `RULES` clamp table stays.
 */

import type { z } from 'zod';

/** Where the body stopped matching, what was wanted, what was actually there. */
export interface Drift {
  readonly at: string;
  readonly expected: string;
  readonly got: string;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly drift: Drift };

export const isDrift = <T>(p: Parsed<T>): p is { readonly ok: false; readonly drift: Drift } => !p.ok;

/**
 * A parser for one labelled boundary. `label` names the endpoint or table, so
 * `at` reads `followersList.users[3].pk` — a log line an adapter author can act on.
 */
export function parseWith<T>(schema: z.ZodType<T>, label: string): (input: unknown) => Parsed<T> {
  return (input: unknown): Parsed<T> => {
    let result: z.ZodSafeParseResult<T>;
    try {
      result = schema.safeParse(input);
    } catch (e) {
      // A schema that throws is itself drift: report it, never propagate.
      return { ok: false, drift: { at: label, expected: 'a parseable schema', got: String(e) } };
    }
    if (result.success) return { ok: true, value: result.data };
    const issue = result.error.issues[0];
    if (!issue) return { ok: false, drift: { at: label, expected: 'a described failure', got: 'no issues' } };
    return {
      ok: false,
      drift: {
        at: label + formatPath(issue.path),
        expected: 'expected' in issue && issue.expected !== undefined ? String(issue.expected) : issue.code,
        got: describe(valueAt(input, issue.path)),
      },
    };
  };
}

/** `['users', 3, 'pk']` → `.users[3].pk`. Symbol keys print as `[Symbol(..)]`. */
function formatPath(path: readonly PropertyKey[]): string {
  return path.map((k) => (typeof k === 'number' ? `[${k}]` : `.${String(k)}`)).join('');
}

/** The value the issue points at, or `undefined` once the path leaves the data. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let cursor = input;
  for (const key of path) {
    if (cursor === null || (typeof cursor !== 'object' && typeof cursor !== 'string')) return undefined;
    cursor = (cursor as Record<PropertyKey, unknown>)[key];
  }
  return cursor;
}

/** A short, safe rendering of a value: its type, plus up to 60 chars of shape. */
function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const type = Array.isArray(value) ? 'array' : typeof value;
  let body: string;
  try {
    body = JSON.stringify(value) ?? String(value);
  } catch {
    body = String(value);
  }
  return `${type} ${body.length > 60 ? `${body.slice(0, 60)}…` : body}`;
}
