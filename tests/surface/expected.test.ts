/**
 * The expected paths and the novelty baseline are evidence, not opinion: every expected path is
 * present in every real body of both corpora, and the baseline is exactly the manifests' unknown
 * keys plus the expected paths. The empty-bio form is read from the scrubbed 2026-11-02 bodies.
 */

import { valueAt } from '@/surface/read/fields';
import { missingPaths } from '@/surface/read/normalize';
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

  test('CORPUS_NOVEL_KEYS is exactly the union of both manifests\' novel keys', () => {
    const pinned = Object.fromEntries(Object.entries(CORPUS_NOVEL_KEYS).map(([k, v]) => [k, [...(v ?? [])].sort()]));
    expect(pinned).toEqual(Object.fromEntries([...union].map(([k, v]) => [k, [...v].sort()])));
  });

  test('the baseline holds every novel key and expected path; the following list shares the followers page', () => {
    for (const [kind, keys] of union) expect(NOVELTY_BASELINE[kind]).toEqual(expect.arrayContaining([...keys, ...(EXPECTED_KEYS[kind] ?? [])]));
    expect(NOVELTY_BASELINE['following-list']).toEqual(expect.arrayContaining([...(union.get('followers-list') ?? [])]));
  });
});

describe('the empty-bio form (spec §7.3)', () => {
  test('the evidence string matches the corpus: no profile body shows an empty or null bio', () => {
    const bios = bodies.filter((x) => x.b.endpoint === 'profile-graphql').map((x) => valueAt(x.body, 'data.user.biography'));
    expect(bios.length).toBe(3);
    expect(bios.every((bio) => typeof bio === 'string' && bio !== '')).toBe(true);
    expect(EMPTY_BIO).toEqual({ form: 'unresolved', evidence: expect.stringContaining('3/3 profile bodies') });
  });
});
