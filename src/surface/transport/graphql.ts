/**
 * The GraphQL envelope (spec §10.5): error text over every entry and every declared text key; a
 * refusal signature makes a wall; errors without the declared root resolve toward waiting; errors
 * beside the root make the read partial. Version-agnostic: the keys and signatures are injected.
 */

import type { GraphqlDecl } from '@/surface/schema/decls';

export type { GraphqlDecl } from '@/surface/schema/decls';

export type GraphqlOutcome =
  | { readonly kind: 'not-graphql' }
  | { readonly kind: 'data'; readonly errors: number }
  | { readonly kind: 'wall'; readonly status: 'action-blocked' | 'challenge' | 'logged-out'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every error entry's declared text keys, joined; `null` when there is none. */
export function graphqlErrorText(json: unknown, decl: GraphqlDecl): string | null {
  const errors = isRecord(json) ? json[decl.errorsKey] : undefined;
  if (!Array.isArray(errors)) return null;
  const texts = errors.flatMap((e) =>
    isRecord(e) ? decl.errorTextKeys.map((k) => e[k]).filter((t): t is string => typeof t === 'string' && t !== '') : []);
  return texts.length > 0 ? texts.join(' — ') : null;
}

/** Classify a body's GraphQL envelope; `rootPresent` says whether the endpoint's declared root came back. */
export function graphqlEnvelope(
  json: unknown,
  rootPresent: (data: unknown) => boolean,
  decl: GraphqlDecl,
  signatures: ReadonlyArray<{ readonly pattern: RegExp; readonly status: string }>,
): GraphqlOutcome {
  if (!isRecord(json) || (!(decl.errorsKey in json) && !(decl.dataKey in json))) return { kind: 'not-graphql' };
  const errors = json[decl.errorsKey];
  if (!Array.isArray(errors) || errors.length === 0) return { kind: 'data', errors: 0 };
  const text = graphqlErrorText(json, decl) ?? '';
  const wall = signatures.find((s) => s.pattern.test(text));
  if (wall !== undefined && (wall.status === 'action-blocked' || wall.status === 'challenge' || wall.status === 'logged-out')) {
    return { kind: 'wall', status: wall.status, text };
  }
  return rootPresent(json[decl.dataKey]) ? { kind: 'data', errors: errors.length } : { kind: 'error', text };
}
