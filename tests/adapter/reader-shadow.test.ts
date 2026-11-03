/**
 * The reverse shadow (spec §10.3): once the document drives an endpoint, the legacy extractors read
 * the same clean canonical bodies as comparators only. A field they read differently is recorded as
 * `shadow-disagreed` through the sink while the document still decides; an intended difference
 * (a quarantined record, a normalized read) is never compared.
 */
import { Reader } from '@/adapter/reader';
import { surface } from '@/surface/index';
import type { SurfaceDocument } from '@/surface/schema/surface';
import { MemorySink } from '@/surface/sink';
import { setLevel } from '@/utils/logger';
import { PROFILE_QUERY, readAs } from '../kit/surface';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const record = (over: Record<string, unknown> = {}) => ({
  pk: '42', id: '42', username: 'subject', biography: 'bio', follower_count: 10, following_count: 20, is_private: false,
  is_verified: false, friendship_status: { following: true, outgoing_request: false, followed_by: false, incoming_request: false },
  ...over,
});
const drifts = (sink: MemorySink) => sink.snapshot().drift.map((d) => [d.signal.cls, d.signal.path]);

/** The active document with the profile projector dropping the bio: the legacy comparator still reads it. */
function bioless(): SurfaceDocument {
  const doc = surface();
  const endpoints = doc.endpoints.map((e) => (e.kind !== 'profile-graphql' ? e : {
    ...e,
    project: (body: unknown, ctx: Parameters<typeof e.project>[1]) => {
      const p = e.project(body, ctx);
      return { ...p, facts: p.facts.map((f) => ({ ...f, fields: { ...f.fields, bio: undefined } })) };
    },
  }));
  return { ...doc, endpoints };
}

test('a clean canonical read the comparators agree with records nothing but its tally', () => {
  const sink = new MemorySink();
  readAs(new Reader({ sink }), 'profile-graphql', { data: { user: record() } }, { at: AT }, PROFILE_QUERY);
  expect(sink.snapshot().tallies['profile-graphql']).toEqual({ canonical: 1 });
  expect(drifts(sink)).toEqual([]);
});

test('a field the comparators read differently is shadow-disagreed, and the document still decides', () => {
  const sink = new MemorySink();
  const read = readAs(new Reader({ doc: bioless(), sink }), 'profile-graphql', { data: { user: record() } }, { at: AT }, PROFILE_QUERY);
  expect(read.ok && read.projection.facts[0]?.fields.bio).toBeUndefined();
  expect(drifts(sink)).toEqual([['shadow-disagreed', 'facts[].fields.bio']]);
  expect(sink.snapshot().tallies['profile-graphql']).toEqual({ canonical: 1, 'shadow-disagreed': 1 });
});

test('an intended difference is never compared: a quarantined record, a normalized read', () => {
  const sink = new MemorySink();
  const reader = new Reader({ doc: bioless(), sink });
  readAs(reader, 'profile-graphql', { data: { user: record({ pk: 2 ** 60, id: undefined }) } }, { at: AT }, PROFILE_QUERY);
  reader.read('profile-graphql', { text: `for (;;);${JSON.stringify({ data: { user: record() } })}` },
    { at: AT, route: reader.route(PROFILE_QUERY) ?? undefined });
  expect(drifts(sink).filter(([cls]) => cls === 'shadow-disagreed')).toEqual([]);
});
