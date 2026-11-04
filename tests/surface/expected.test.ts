/**
 * The expected paths and the novelty baseline are evidence, not opinion: every expected path is
 * present in every real corpus body, and the baseline is exactly the manifests' unknown keys plus
 * the expected paths. The empty-bio form is observed in the scrubbed 2026-11-04 profile body.
 */

import { valueAt } from '@/surface/read/fields';
import { missingPaths } from '@/surface/read/normalize';
import { readBody } from '@/surface/read/read';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { CONTAINERS } from '@/surface/versions/2026-08-12/containers';
import { CORPUS_NOVEL_KEYS, EMPTY_BIO, EXPECTED_KEYS, NOVELTY_BASELINE } from '@/surface/versions/2026-08-12/expected';
import { bodyOf, CORPORA, hasCorpusAt, manifestOf } from './corpus';

const bodies = [...CORPORA].filter(hasCorpusAt).flatMap((id) => manifestOf(id).bodies.map((b) => ({ id, b, body: bodyOf(id, b.file) })));

/** The record the expected paths are relative to: the container the body's route declares. */
function recordOf(kind: EndpointKind, body: unknown): unknown {
  const graphql = typeof body === 'object' && body !== null && 'data' in body;
  if (kind === 'profile-graphql') return valueAt(body, CONTAINERS.profileGraphql[0].at);
  if (kind === 'activity-feed' && graphql) return valueAt(body, CONTAINERS.feedGraphql[0].at);
  if (kind === 'friend-requests' && graphql) {
    const conn = CONTAINERS.requestsGraphql[0];
    const edges = valueAt(body, `${conn.at}.${conn.connection.edges}`) as unknown[];
    return { users: edges.map((e) => valueAt(e, conn.connection.node)) };
  }
  return body;
}

describe('EXPECTED_KEYS', () => {
  test.each(bodies.map((x) => [`${x.id}/${x.b.file}`, x] as const))('%s carries every expected path', (_n, { b, body }) => {
    expect(missingPaths(recordOf(b.endpoint, body), EXPECTED_KEYS[b.endpoint] ?? [])).toEqual([]);
  });

  test('the profile read expects the bio and the verified badge (every click verdict depends on them)', () => {
    expect(EXPECTED_KEYS['profile-graphql']).toEqual(expect.arrayContaining(['biography', 'is_verified']));
  });
});

describe('NOVELTY_BASELINE is pinned to the manifests', () => {
  const union = new Map<EndpointKind, Set<string>>();
  for (const { b } of bodies) union.set(b.endpoint, new Set([...(union.get(b.endpoint) ?? []), ...b.expect.novelKeys]));

  test('CORPUS_NOVEL_KEYS is exactly the union of the manifests\' novel keys', () => {
    const pinned = Object.fromEntries(Object.entries(CORPUS_NOVEL_KEYS).map(([k, v]) => [k, [...(v ?? [])].sort()]));
    expect(pinned).toEqual(Object.fromEntries([...union].map(([k, v]) => [k, [...v].sort()])));
  });

  test('the baseline holds every novel key and expected path; the following list shares the followers page', () => {
    for (const [kind, keys] of union) expect(NOVELTY_BASELINE[kind]).toEqual(expect.arrayContaining([...keys, ...(EXPECTED_KEYS[kind] ?? [])]));
    expect(NOVELTY_BASELINE['following-list']).toEqual(expect.arrayContaining([...(union.get('followers-list') ?? [])]));
  });
});

describe('the empty-bio form (spec §7.3)', () => {
  const observed = (): { data: { user: Record<string, unknown> } } =>
    bodyOf('2026-11-04', 'profile-graphql-empty-bio.json') as { data: { user: Record<string, unknown> } };
  const read = (body: unknown) => readBody('profile-graphql', {
    decoded: { ok: true, json: body, format: 'json', payloads: 1, final: null },
  }, { at: manifestOf('2026-11-04').replayAt, source: 'profile' });

  test('the canonical private profile establishes an empty string with every decision field read', () => {
    const bios = bodies.filter((x) => x.b.endpoint === 'profile-graphql').map((x) => valueAt(x.body, 'data.user.biography'));
    expect(bios).toHaveLength(4);
    expect(bios.filter((bio) => bio === '')).toHaveLength(1);
    expect(bios.every((bio) => typeof bio === 'string')).toBe(true);
    const body = observed();
    expect(body.data.user.biography).toBe('');
    expect(body.data.user.is_private).toBe(true);
    expect(read(body)).toMatchObject({ ok: true, tier: 'canonical', partial: false,
      projection: { fieldIssues: [], presence: { counts: 'read', bio: 'read', isPrivate: 'read', isVerified: 'read', relationship: 'read' },
        facts: [{ fields: { bio: '' } }] } });
    expect(EMPTY_BIO).toEqual({ form: 'empty-string', evidence: expect.stringContaining('2026-11-04 corpus') });
  });

  test.each(['null', 'absent'] as const)('%s remains unread rather than becoming the observed empty string', (presence) => {
    const body = observed();
    if (presence === 'null') body.data.user.biography = null;
    else delete body.data.user.biography;
    const result = read(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.presence?.bio).toBe(presence);
    expect(result.projection.facts[0]?.fields.bio).toBeUndefined();
    expect(result.projection.fieldIssues.map((issue) => `${issue.kind}:${issue.path}`))
      .toEqual(presence === 'absent' ? ['expected-absent:biography'] : []);
  });
});
