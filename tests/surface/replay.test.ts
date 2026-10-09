/**
 * REPLAY — the contract test the corpus exists for.
 *
 * Every committed body is routed by the document's own match pattern, parsed by
 * its endpoint's schema, and projected; the fact count, cursor, `hasMore` and
 * relationship count must equal what the manifest recorded. A version bump that
 * reshapes an endpoint fails here, in milliseconds, in CI — which is the whole
 * point of scrubbing the corpus in the first place.
 *
 * It also runs the SHADOW comparison in reverse: the legacy extractor and the
 * schema must agree on every real body. That is the evidence that earns an
 * endpoint's flip from `observe` to `enforce`, and it is checked against real
 * captured shapes rather than hand-written ones.
 */

import { SURFACE } from '@/adapter/ig-surface';
import { isShapeMismatch } from '@/adapter/parse-helpers';
import { endpointOf, matchEndpoint, surface } from '@/surface/index';
import { readResponse } from '@/surface/parse';
import { PATHS } from '@/surface/versions/2026-08-12/literals';
import { body, hasCorpus, manifest } from './corpus';

const doc = surface();
const corpus = hasCorpus() ? manifest() : null;

describe('the surface document loads and validates', () => {
  test('the active document is valid and names the corpus it is tested against', () => {
    expect(doc.id).toBe('2026-08-12');
    expect(corpus?.surfaceId).toBe(doc.id);
  });

  test('every endpoint kind has a response schema and a projector', () => {
    for (const endpoint of doc.endpoints) {
      expect(typeof endpoint.project).toBe('function');
      expect(endpoint.response).toBeDefined();
      // Nothing may be flipped to `enforce` while the shadow record is this thin.
      expect(endpoint.mode).toBe('observe');
    }
  });

  test('an `escape` control names the ADR that authorised it', () => {
    for (const [id, control] of Object.entries(doc.controls)) {
      if (control.strategy !== 'escape') continue;
      expect(typeof control.adr).toBe('string');
      expect(`${id}:${control.adr}`).toMatch(/:0\d{3}$/);
    }
  });
});

describe('the URLs the surface BUILDS are the URLs it ROUTES', () => {
  // The half of endpoint routing nothing tested before: a fetch script composes
  // a URL from `PATHS`, and a separate regex decides which parser sees the
  // response. If those two ever disagree, a read silently stops being ingested.
  const cases: Array<[string, string]> = [
    ['followers-list', `${PATHS.friendshipsList}12345/followers/?count=50`],
    ['following-list', `${PATHS.friendshipsList}12345/following/?count=50`],
    // Observed only since 2026-10-08 (Epo no longer composes either).
    ['friendship-show', '/api/v1/friendships/show/12345/'],
    ['profile-info', '/api/v1/users/12345/info/'],
    ['show-many', '/api/v1/friendships/show_many/'],
    ['activity-feed', '/api/v1/news/inbox/'],
    ['friend-requests', '/api/v1/friendships/pending/'],
  ];

  test.each(cases)('%s routes its own URL', (kind, url) => {
    expect(matchEndpoint(url)?.kind).toBe(kind);
    // …and the legacy façade must agree, or the shadow parse would be comparing
    // two different endpoints' answers.
    expect(SURFACE.matchEndpoint(url)).toBe(kind);
  });

  test('the composed list-page script carries the path the matcher expects', () => {
    const script = SURFACE.listPageScript('12345', 'followers', null);
    expect(script).toContain(PATHS.friendshipsList);
    expect(script).toContain('/followers/?count=');
  });

  test('a followers URL yields its target pk, a show URL its subject pk', () => {
    expect(SURFACE.extractIds('followers-list', `${PATHS.friendshipsList}999/followers/`)).toEqual({
      targetPk: '999',
    });
    expect(SURFACE.extractIds('friendship-show', '/api/v1/friendships/show/999/')).toEqual({
      pk: '999',
    });
  });
});

(corpus === null ? describe.skip : describe)('every committed body replays', () => {
  const bodies = corpus?.bodies ?? [];

  test('the corpus covers the endpoints the capture reached', () => {
    expect(bodies.length).toBeGreaterThan(0);
    // Documented blind spots, not a silent gap: the 2026-08-12 capture never
    // opened the notifications drawer, and the following-list endpoint shares
    // the followers-list shape so it was never separately recorded. The two
    // profile endpoints post-date the capture — they replaced the retired
    // `web_profile_info` on 2026-09-18 and are covered by unit tests until a
    // fresh capture lands real bodies for them.
    expect(corpus?.missing).toEqual([
      'following-list',
      'activity-feed',
      'profile-info',
      'profile-graphql',
    ]);
  });

  test.each(bodies.map((b) => [b.file, b] as const))('%s parses and projects', (_file, entry) => {
    const endpoint = endpointOf(entry.endpoint);
    expect(endpoint).not.toBeNull();
    const result = readResponse(endpoint as NonNullable<typeof endpoint>, body(entry.file), {
      at: corpus?.replayAt ?? 0,
      source: entry.source,
      pk: entry.pk,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({
      facts: result.projection.facts.length,
      relationships: result.projection.relationships.length,
      events: result.projection.events.length,
      cursor: result.projection.cursor,
      hasMore: result.projection.hasMore,
      absent: result.projection.absent,
      rowIssues: result.projection.rowIssues.length,
    }).toEqual({
      facts: entry.expect.facts,
      relationships: entry.expect.relationships,
      events: entry.expect.events,
      cursor: entry.expect.cursor,
      hasMore: entry.expect.hasMore,
      absent: entry.expect.absent,
      rowIssues: entry.expect.rowIssues,
    });
    // §1: one fact per row, each carrying its own pk — a projection that
    // returned a batch summary instead could not satisfy this.
    for (const fact of result.projection.facts) {
      expect(fact.accountPk).toMatch(/^\d+$/);
      expect(fact.source).toBe(entry.source);
    }
    expect([...result.novelKeys]).toEqual(entry.expect.novelKeys);
  });
});

(corpus === null ? describe.skip : describe)('schema and legacy extractor agree on real bodies', () => {
  const lists = (corpus?.bodies ?? []).filter(
    (b) => b.endpoint === 'followers-list' || b.endpoint === 'friend-requests',
  );

  test.each(lists.map((b) => [b.file, b] as const))(
    '%s: the extractor reads the same rows and cursor',
    (_file, entry) => {
      const raw = body(entry.file);
      const legacy = SURFACE.extractFollowersList(raw, 0, entry.source as 'followers-list');
      expect(isShapeMismatch(legacy)).toBe(false);
      if (isShapeMismatch(legacy)) return;
      expect(legacy.observations.length).toBe(entry.expect.facts);
      expect(legacy.cursor).toBe(entry.expect.cursor);
      expect(legacy.hasMore).toBe(entry.expect.hasMore);
    },
  );

  // Empty until a capture lands real profile bodies for the post-retirement
  // endpoints (see the `missing` list above), and `test.each` rejects an empty
  // table — so the comparison registers only once there is something to compare.
  const profiles = (corpus?.bodies ?? []).filter((b) => b.endpoint === 'profile-info');
  if (profiles.length === 0) {
    test.skip('no profile body in the corpus yet (endpoint replaced 2026-09-18)', () => {});
  } else {
    test.each(profiles.map((b) => [b.file, b] as const))(
      '%s: the extractor reads the same profile',
      (_file, entry) => {
        const legacy = SURFACE.extractProfileInfo(body(entry.file), 0);
        expect(isShapeMismatch(legacy)).toBe(false);
        expect(legacy === null).toBe(entry.expect.absent === true);
      },
    );
  }

  const many = (corpus?.bodies ?? []).filter((b) => b.endpoint === 'show-many');
  test.each(many.map((b) => [b.file, b] as const))(
    '%s: the extractor reads the same relationships',
    (_file, entry) => {
      const legacy = SURFACE.extractShowMany(body(entry.file));
      expect(isShapeMismatch(legacy)).toBe(false);
      if (isShapeMismatch(legacy)) return;
      expect(legacy.length).toBe(entry.expect.relationships);
    },
  );
});

describe('drift never collapses to a fact (ADR 0303, now structural)', () => {
  const listEndpoint = endpointOf('followers-list');

  test('a page whose `users` container is gone is a MISMATCH, not an empty page', () => {
    const drifted = { next_max_id: null, has_more: false };
    const result = readResponse(listEndpoint as NonNullable<typeof listEndpoint>, drifted, {
      at: 0,
      source: 'followers-list',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('users');
    // The mismatch shape has no `cursor`/`hasMore` to read, so an end-of-list
    // claim cannot be constructed from it even by accident.
    expect('projection' in result).toBe(false);
  });

  test('a `{"status":"fail"}` body is a mismatch for friendship-show, never all-false', () => {
    const endpoint = endpointOf('friendship-show');
    const result = readResponse(endpoint as NonNullable<typeof endpoint>, { status: 'fail' }, {
      at: 0,
      source: 'show-many',
      pk: '1',
    });
    expect(result.ok).toBe(false);
  });

  test('a soft-block body is a mismatch for profile-info, never a deletion', () => {
    const endpoint = endpointOf('profile-info');
    const blocked = readResponse(endpoint as NonNullable<typeof endpoint>, { status: 'fail' }, {
      at: 0,
      source: 'profile',
    });
    expect(blocked.ok).toBe(false);

    // …while a present-but-empty `user` container IS Instagram saying gone.
    const gone = readResponse(endpoint as NonNullable<typeof endpoint>, { user: null }, {
      at: 0,
      source: 'profile',
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.projection.absent).toBe(true);
    expect(gone.projection.facts).toEqual([]);
  });

  test('the same guard holds for the observed GraphQL profile body', () => {
    const endpoint = endpointOf('profile-graphql');
    const blocked = readResponse(endpoint as NonNullable<typeof endpoint>, { status: 'fail' }, {
      at: 0,
      source: 'profile',
    });
    expect(blocked.ok).toBe(false);

    const gone = readResponse(endpoint as NonNullable<typeof endpoint>, { data: { user: null } }, {
      at: 0,
      source: 'profile',
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(gone.projection.absent).toBe(true);
  });

  test('a feed with no story container is a mismatch, an empty one is a valid result', () => {
    const endpoint = endpointOf('activity-feed');
    const drifted = readResponse(endpoint as NonNullable<typeof endpoint>, { inbox: [] }, {
      at: 0,
      source: 'activity-feed',
    });
    expect(drifted.ok).toBe(false);

    const empty = readResponse(endpoint as NonNullable<typeof endpoint>, { new_stories: [] }, {
      at: 0,
      source: 'activity-feed',
    });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(empty.projection.events).toEqual([]);
  });

  test('a malformed ROW is counted, not fatal — the other rows are facts already paid for', () => {
    const result = readResponse(
      listEndpoint as NonNullable<typeof listEndpoint>,
      { users: [{ pk: '1', username: 'user_a1' }, { nope: true }], next_max_id: '50' },
      { at: 0, source: 'followers-list' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.facts).toHaveLength(1);
    expect(result.projection.rowIssues).toEqual([
      { index: 1, path: 'pk', message: expect.any(String) },
    ]);
  });
});
