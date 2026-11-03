/**
 * The Reader's shadow parse and the comparators it reports with, plus the two
 * body helpers every Reader parse shares (JSON coercion and the drift warning).
 */

import type {
  EndpointKind,
  FollowEvent,
  FollowersListResult,
  FriendshipShowResult,
  ShowManyEntry,
} from '@/adapter/ig-surface';
import type { ProjectCtx, Projection } from '@/surface/schema/surface';
import { type ShadowCompare, shadowParse } from '@/surface/shadow';
import * as logger from '@/utils/logger';

/** A projected profile fact; the legacy profile extractor yields the same shape. */
type ProfileFact = Projection['facts'][number];

/**
 * Accept either an already-parsed object or a raw JSON string (what
 * `TabResponse.getBody()` yields). A malformed string is logged (never
 * silently swallowed) and treated as no-match.
 */
export function coerceBody(body: unknown, kind: EndpointKind): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch (e) {
    logger.warn('reader.parse: body was not valid JSON', {
      kind,
      error: String(e),
    });
    return undefined;
  }
}

export function warnUnexpected(kind: EndpointKind, body: unknown): void {
  const keys =
    typeof body === 'object' && body !== null ? Object.keys(body as object) : [];
  logger.warn('reader.parse: unexpected body shape', { kind, keys });
}

// -------------------------------------------------------------------------
// Shadow parse (PHASE 1 of the surface migration)
//
// Every parse in the Reader still DRIVES BEHAVIOUR through the legacy
// extractor. The calls below run the endpoint's zod schema over the same body
// and report a disagreement — nothing more. That is what earns the right to
// flip an endpoint's `mode` to `enforce`: real disagreement counts over real
// sessions, per endpoint, reversible without a release.
//
// Wrapped so it can NEVER break the live path: a shadow parse that can throw
// into a census walk is worse than no shadow parse at all.
// -------------------------------------------------------------------------

export function shadowRead(
  kind: EndpointKind,
  body: unknown,
  at: number,
  source: ProjectCtx['source'],
  legacyMismatch: boolean,
  compare?: ShadowCompare,
  pk?: string,
): void {
  try {
    shadowParse({
      kind,
      body: coerceBody(body, kind),
      ctx: { at, source, pk },
      legacyMismatch,
      compare,
    });
  } catch (e) {
    logger.debug('reader.shadow: shadow parse failed', { kind, error: String(e) });
  }
}

/** Compare a list projection against the legacy list result. */
export function compareList(legacy: FollowersListResult | null): ShadowCompare {
  return (p) => {
    if (legacy === null) return 'extractor reported a mismatch, schema parsed';
    const diffs: string[] = [];
    if (p.facts.length !== legacy.observations.length) {
      diffs.push(`rows ${p.facts.length} vs ${legacy.observations.length}`);
    }
    if (p.cursor !== legacy.cursor) diffs.push(`cursor ${p.cursor} vs ${legacy.cursor}`);
    if (p.hasMore !== legacy.hasMore) diffs.push(`hasMore ${p.hasMore} vs ${legacy.hasMore}`);
    const mismatchedPk = p.facts.find(
      (f, i) => legacy.observations[i]?.accountPk !== f.accountPk,
    );
    if (mismatchedPk !== undefined) diffs.push(`pk order diverges at ${mismatchedPk.accountPk}`);
    return diffs.length === 0 ? null : diffs.join(', ');
  };
}

/** Compare a profile projection against the legacy profile observation (`null`: none read). */
export function compareProfile(legacy: ProfileFact | null): ShadowCompare {
  return (p) => {
    if (legacy === null) {
      return p.absent === true ? null : 'extractor read no profile, schema projected one';
    }
    const fact = p.facts[0];
    if (fact === undefined) return 'schema projected no profile, extractor read one';
    if (fact.accountPk !== legacy.accountPk) {
      return `pk ${fact.accountPk} vs ${legacy.accountPk}`;
    }
    if (fact.fields.followers !== legacy.fields.followers) {
      return `followers ${fact.fields.followers} vs ${legacy.fields.followers}`;
    }
    if (fact.fields.username !== legacy.fields.username) {
      return `username differs for ${fact.accountPk}`;
    }
    return null;
  };
}

/** Compare the batched relationship rows against the legacy show-many entries. */
export function compareShowMany(legacy: ShowManyEntry[] | null): ShadowCompare {
  return (p) => {
    if (legacy === null) return 'extractor reported a mismatch, schema parsed';
    if (p.relationships.length !== legacy.length) {
      return `rows ${p.relationships.length} vs ${legacy.length}`;
    }
    for (const row of p.relationships) {
      const twin = legacy.find((e) => e.pk === row.pk);
      if (twin === undefined) return `pk ${row.pk} missing from the extractor's rows`;
      if (twin.following !== row.following || twin.outgoingRequest !== row.outgoingRequest) {
        return `relationship differs for ${row.pk}`;
      }
    }
    return null;
  };
}

/** Compare the single relationship row against the legacy friendship-show result. */
export function compareFriendshipShow(
  legacyShow: FriendshipShowResult | null,
  pk: string,
): ShadowCompare {
  return (p) => {
    if (legacyShow === null) return 'extractor reported a mismatch, schema parsed';
    const row = p.relationships[0];
    if (row === undefined) return 'schema projected no relationship';
    if (
      row.following !== legacyShow.following ||
      row.followedBy !== legacyShow.followedBy ||
      row.outgoingRequest !== legacyShow.outgoingRequest
    ) {
      return `relationship differs for ${pk}`;
    }
    return null;
  };
}

/** Compare the projected follow events against the legacy activity-feed events. */
export function compareActivityFeed(legacy: FollowEvent[] | null): ShadowCompare {
  return (p) => {
    if (legacy === null) return 'extractor reported a mismatch, schema parsed';
    if (p.events.length !== legacy.length) {
      return `events ${p.events.length} vs ${legacy.length}`;
    }
    const diverged = p.events.find((e, i) => legacy[i]?.pk !== e.pk);
    return diverged === undefined ? null : `event pk order diverges at ${diverged.pk}`;
  };
}
