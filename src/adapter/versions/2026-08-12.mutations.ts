/**
 * Instagram surface — capture 2026-08-12: mutation recognition + verdict.
 *
 * Split out of the adapter façade (`2026-08-12.ts`) so both stay inside the
 * line budget. Same constraint as the façade: NO Instagram literal of its own —
 * the routing table is read off the validated surface document and every key
 * comes from the literals module.
 */

import type {
  MutationKind,
  MutationMatch,
  MutationRequest,
  MutationVerdict,
} from '@/adapter/mutation-types';
import { isRecord, SHAPE_MISMATCH, type ShapeMismatch } from '@/adapter/parse-helpers';
import {
  GRAPHQL_FRIENDLY_NAME_HEADER,
  GRAPHQL_MUTATION_NAME,
  MUTATION_JSON,
} from '@/surface/versions/2026-08-12/literals';
import { SURFACE_DOC_2026_08_12 as DOC } from '@/surface/versions/2026-08-12/surface';

export function matchMutation(req: MutationRequest): MutationMatch | null {
  if (req.method !== undefined && req.method.toUpperCase() !== 'POST') return null;
  const friendly = req.requestHeaders?.[GRAPHQL_FRIENDLY_NAME_HEADER];
  for (const entry of DOC.mutations) {
    if (!entry.match.url.test(req.url)) continue;
    if (entry.friendlyName !== undefined) {
      // A GraphQL request is opaque by URL: it is a MUTATION only when the
      // friendly-name header says so, and which mutation only by that name.
      if (typeof friendly !== 'string' || !GRAPHQL_MUTATION_NAME.test(friendly)) continue;
      if (!entry.friendlyName.test(friendly)) continue;
      return { kind: entry.kind, pk: null };
    }
    const m = entry.match.url.exec(req.url);
    if (m) return { kind: entry.kind, pk: m[1] ?? null };
  }
  return null;
}

/** Read the REST-style verdict keys off one record; `null` when it carries no `status`. */
function readMutationRecord(rec: Record<string, unknown>): MutationVerdict | null {
  const p = MUTATION_JSON;
  const status = rec[p.status];
  if (status !== p.ok && status !== p.fail) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const feedbackText = [str(rec[p.feedbackTitle]), str(rec[p.feedbackMessage])]
    .filter((s): s is string => s !== null)
    .join(' — ');
  return {
    verdict: status === p.ok ? 'ok' : 'fail',
    result: str(rec[p.result]),
    message: str(rec[p.message]),
    feedbackText: feedbackText !== '' ? feedbackText : null,
    spam: rec[p.spam] === true,
  };
}

/** The relationship a GraphQL mutation child's `friendship_status` reports; `null` when unreadable. */
function readFriendshipResult(child: Record<string, unknown>): string | null {
  const fs = child[MUTATION_JSON.friendshipStatus];
  if (!isRecord(fs)) return null;
  if (fs[MUTATION_JSON.following] === true) return 'following';
  if (fs[MUTATION_JSON.outgoingRequest] === true) return 'requested';
  return fs[MUTATION_JSON.following] === false ? 'not-following' : null;
}

/** Does the relationship an ok envelope reports CONTRADICT the op that was pressed? */
const contradicts = (kind: MutationKind | undefined, result: string): boolean =>
  kind === 'follow' ? result === 'not-following' : kind === 'unfollow' && result !== 'not-following';

/**
 * The server's verdict in a mutation body. With `kind`, a GraphQL success whose
 * `friendship_status` contradicts the op (a "follow" that leaves us not
 * following — a refusal that never said so) is `SHAPE_MISMATCH`: the DOM decides.
 */
export function extractMutationVerdict(
  body: unknown,
  kind?: MutationKind,
): MutationVerdict | ShapeMismatch {
  if (!isRecord(body)) return SHAPE_MISMATCH;
  const direct = readMutationRecord(body);
  if (direct?.verdict === 'fail') return direct;
  // GraphQL `errors` outrank the envelope's own top-level `status: "ok"`, which
  // describes the exchange, not the mutation.
  const errors = body[MUTATION_JSON.errors];
  if (Array.isArray(errors) && errors.length > 0) {
    const first: unknown = errors[0];
    const message = isRecord(first) ? first[MUTATION_JSON.message] : null;
    return {
      verdict: 'fail',
      result: null,
      message: typeof message === 'string' ? message : null,
      feedbackText: null,
      spam: false,
    };
  }
  const data = body[MUTATION_JSON.data];
  if (data === undefined) return direct ?? SHAPE_MISMATCH;
  if (!isRecord(data)) return SHAPE_MISMATCH;
  // A GraphQL success is READ, never assumed: a child must carry a REST-style
  // verdict or the relationship it left behind. `{ data: { op: null } }` is unknown.
  for (const child of Object.values(data)) {
    if (!isRecord(child)) continue;
    const nested = readMutationRecord(child);
    if (nested !== null) return nested;
    const result = readFriendshipResult(child);
    if (result === null) continue;
    if (contradicts(kind, result)) return SHAPE_MISMATCH;
    return { verdict: 'ok', result, message: null, feedbackText: null, spam: false };
  }
  return SHAPE_MISMATCH;
}
