/**
 * `readBody` (spec §10.2–10.3, Appendix D.1): the gate, the decode, the GraphQL envelope, the
 * declared containers and the field readers, with every read reported to the sink. Failures are
 * typed; "gone" needs Instagram's own explicit null; a null relationship is "self" only for the viewer.
 */
import { routeOf, surface } from '@/surface/index';
import { readBody } from '@/surface/read/read';
import type { BodyInput, ReadCtx, SurfaceRead } from '@/surface/read/types';
import { NO_HINTS } from '@/surface/recovery/hints';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { MemorySink, NO_SINK } from '@/surface/sink';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const PROFILE_OP = { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' };
const profileRoute = routeOf({ url: 'https://www.instagram.com/api/graphql', requestHeaders: PROFILE_OP }) ?? undefined;
const json = (v: unknown, final: boolean | null = null): BodyInput => ({ decoded: { ok: true, json: v, format: 'json', payloads: 1, final } });
const user = (over: Record<string, unknown> = {}) => ({
  pk: '42', id: '42', username: 'subject', biography: '', follower_count: 10, following_count: 20, mutual_followers_count: 1,
  is_private: false, is_verified: false,
  friendship_status: { following: true, outgoing_request: false, followed_by: true, incoming_request: false }, ...over,
});
const profile = (u: unknown, viewer?: string) => ({ data: { user: u, ...(viewer === undefined ? {} : { viewer: { user: { pk: viewer, id: viewer } } }) } });

function readWith(kind: EndpointKind, input: BodyInput, ctx: Partial<ReadCtx> = {}): { read: SurfaceRead; sink: MemorySink } {
  const sink = new MemorySink();
  const read = readBody(kind, input, { at: AT, ...ctx }, { doc: surface(), sink, hints: NO_HINTS });
  return { read, sink };
}

describe('typed failures, never a fact', () => {
  test.each([
    ['a 429', 429, 'application/json', 'wall'],
    ['a 401', 401, 'application/json', 'wall'],
    ['an HTML page on an API URL', 200, 'text/html', 'wall'],
    ['a 404', 404, 'application/json', 'http-absent'],
    ['an unparseable media type', 200, 'image/png', 'not-data'],
  ])('%s', (_name, status, mime, kind) => {
    const { read, sink } = readWith('profile-graphql', { text: '{}', status, mime }, { route: profileRoute });
    expect(read).toMatchObject({ ok: false, kind });
    expect(sink.snapshot().tallies['profile-graphql']).toEqual({ [kind === 'wall' ? 'wall' : 'failed']: 1 });
  });

  test('a body that does not decode is a transport failure', () => {
    expect(readWith('followers-list', { text: 'not json {' }).read).toMatchObject({ ok: false, kind: 'transport', reason: 'invalid-json' });
  });

  test('a body with no declared container is a mismatch naming the DECODED keys, never the values', () => {
    const { read, sink } = readWith('profile-graphql', json({ status: 'fail', message: 'secret' }), { route: profileRoute });
    expect(read).toMatchObject({ ok: false, kind: 'mismatch', keys: ['status', 'message'] });
    expect(JSON.stringify(sink.snapshot().drift)).not.toContain('secret');
  });

  test('errors with no profile resolve toward waiting (a server-error wall), a refusal signature to its wall', () => {
    const errors = (message: string) => ({ data: { user: null }, errors: [{ message }] });
    expect(readWith('profile-graphql', json(errors('boom')), { route: profileRoute }).read)
      .toMatchObject({ ok: false, kind: 'wall', family: 'server-error', via: 'graphql' });
    expect(readWith('profile-graphql', json(errors('Please wait a few minutes')), { route: profileRoute }).read)
      .toMatchObject({ ok: false, kind: 'wall', family: 'rate-limited', via: 'graphql' });
    expect(readWith('profile-graphql', json(errors('login_required')), { route: profileRoute }).read)
      .toMatchObject({ ok: false, kind: 'wall', family: 'auth' });
  });
});

describe('"gone" needs evidence (spec §10.4)', () => {
  test('the container present and null, no errors, a final body: absent at C0', () => {
    expect(readWith('profile-graphql', json(profile(null)), { route: profileRoute }).read)
      .toMatchObject({ ok: true, tier: 'canonical', partial: false, projection: { absent: true, facts: [] } });
  });

  test('a stream that is not final yet knows nothing: no absence', () => {
    expect(readWith('profile-graphql', json(profile(null), false), { route: profileRoute }).read)
      .toMatchObject({ ok: true, partial: true, projection: { absent: null, facts: [] } });
  });

  test('a missing user key is drift, not a deletion', () => {
    expect(readWith('profile-graphql', json({ data: {} }), { route: profileRoute }).read).toMatchObject({ ok: false, kind: 'mismatch' });
  });
});

describe('the profile record, field by field', () => {
  test('every decision-bearing field read: canonical, presence read, one tri-state relationship', () => {
    const { read, sink } = readWith('profile-graphql', json(profile(user(), '7')), { route: profileRoute });
    expect(read).toMatchObject({ ok: true, tier: 'canonical', partial: false,
      projection: { viewerPk: '7', fieldIssues: [], presence: { counts: 'read', bio: 'read', isPrivate: 'read', isVerified: 'read', relationship: 'read' },
        facts: [{ accountPk: '42', fields: { username: 'subject', followers: 10, following: 20, mutuals: 1, bio: '' } }],
        relationships: [{ pk: '42', following: true, outgoingRequest: false, followedBy: true, incomingRequest: false }] } });
    expect(sink.snapshot()).toMatchObject({ tallies: { 'profile-graphql': { canonical: 1 } }, drift: [] });
  });

  test('I10: a null relationship is "self" only on the viewer\'s own record; elsewhere it is unexpected', () => {
    const self = readWith('profile-graphql', json(profile(user({ friendship_status: null }), '42')), { route: profileRoute }).read;
    expect(self.ok && self.projection.presence?.relationship).toBe('self');
    expect(self.ok && self.projection.fieldIssues).toEqual([]);
    const other = readWith('profile-graphql', json(profile(user({ friendship_status: null }), '7')), { route: profileRoute });
    expect(other.read.ok && other.read.projection.fieldIssues).toEqual([{ path: 'friendship_status', kind: 'unexpected-null', got: 'null' }]);
    expect(other.sink.snapshot().drift.map((d) => [d.signal.cls, d.signal.path])).toEqual([['unexpected-null', 'friendship_status']]);
  });

  test('a missing bio or verified badge raises expected-absent (the profiles area pauses unfollows), an explicit null does not', () => {
    const { biography: _b, is_verified: _v, ...rest } = user();
    const { read, sink } = readWith('profile-graphql', json(profile(rest, '7')), { route: profileRoute });
    expect(read.ok && read.projection.fieldIssues.map((i) => `${i.kind}:${i.path}`).sort())
      .toEqual(['expected-absent:biography', 'expected-absent:is_verified']);
    expect(sink.snapshot().drift.map((d) => d.signal.cls)).toEqual(['expected-absent', 'expected-absent']);
    const nulled = readWith('profile-graphql', json(profile(user({ biography: null }), '7')), { route: profileRoute }).read;
    expect(nulled.ok && nulled.projection).toMatchObject({ fieldIssues: [], presence: { bio: 'null' } });
    expect(nulled.ok && nulled.projection.facts[0]?.fields.bio).toBeUndefined();
  });

  test('a renamed relationship key is unknown, and its absence is reported', () => {
    const fs = { following: false, outgoing_request_v2: true, followed_by: false, incoming_request: false };
    const { read } = readWith('profile-graphql', json(profile(user({ friendship_status: fs }), '7')), { route: profileRoute });
    expect(read.ok && read.projection.relationships[0]?.outgoingRequest).toBeNull();
    expect(read.ok && read.projection.fieldIssues).toContainEqual({ path: 'friendship_status.outgoing_request', kind: 'expected-absent', got: 'absent' });
  });

  test('a partial count pair stores no count and says why', () => {
    const { read } = readWith('profile-graphql', json(profile(user({ follower_count: undefined }), '7')), { route: profileRoute });
    expect(read.ok && read.projection.facts[0]?.fields.followers).toBeUndefined();
    expect(read.ok && read.projection.presence?.counts).toBe('partial');
  });
});

describe('rows and stories read one by one', () => {
  const page = (users: unknown[], extra: Record<string, unknown> = {}) => ({ users, has_more: false, big_list: false, ...extra });
  const row = (pk: string) => ({ pk, pk_id: pk, id: pk, strong_id__: pk, username: `user_${pk}` });

  test('a row with conflicting ids is quarantined; a page that mostly fails is unreadable', () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => row(String(i + 1))), { ...row('99'), id: '98' }];
    const ok = readWith('followers-list', json(page(rows))).read;
    expect(ok).toMatchObject({ ok: true, projection: { rowIssues: [{ index: 10, path: 'id', message: 'id-conflict' }] } });
    const bad = readWith('followers-list', json(page([row('1'), { username: 'x' }]))).read;
    expect(bad).toMatchObject({ ok: false, kind: 'rows-unreadable', rows: 2, quarantined: 1 });
  });

  test('foreign ids never vote: an fbid alone is no id', () => {
    const { read } = readWith('followers-list', json(page([{ fbid_v2: '17841', username: 'x' }])));
    expect(read).toMatchObject({ ok: false, kind: 'rows-unreadable' });
  });

  test('no cursor and no flags is an end without evidence, reported', () => {
    const { read, sink } = readWith('followers-list', json({ users: [row('1')] }));
    expect(read.ok && read.projection.continuation).toEqual({ kind: 'end', evidence: 'no-flags' });
    expect(sink.snapshot().drift.map((d) => d.signal.cls)).toEqual(['expected-absent']);
  });

  const story = (type: unknown, args: Record<string, unknown>) => ({ story_type: type, args });
  test('one odd story never costs the page; an unknown type is enum-novel; a time out of range is null', () => {
    const inbox = { new_stories: [], old_stories: [
      story(101, { profile_id: '11', profile_name: 'a', timestamp: 1_786_000_000 }),
      'not a story',
      story(4242, { profile_id: '12', text: 'liked your photo' }),
      story(101, { inline_follow: { user_info: { pk: '13' } }, timestamp: 9_999_999_999 }),
    ] };
    const { read } = readWith('activity-feed', json(inbox));
    expect(read).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'alias-key', at: 'old_stories[].args.inline_follow.user_info.pk' }] });
    expect(read.ok && read.projection.events).toEqual([
      { pk: '11', username: 'a', atMs: 1_786_000_000_000 }, { pk: '13', username: null, atMs: null },
    ]);
    expect(read.ok && read.projection.rowIssues).toEqual([{ index: 1, path: '(row)', message: 'the story is string' }]);
    expect(read.ok && read.projection.fieldIssues.map((i) => i.kind)).toEqual(['enum-novel', 'time-range']);
  });
});

describe('the sink hears every read once', () => {
  test('a novel key outside the corpus baseline is reported; a baseline key is not', () => {
    const { sink } = readWith('profile-graphql', json({ ...profile(user(), '7'), extensions: {}, brand_new: 1 }), { route: profileRoute });
    expect(sink.snapshot().drift.map((d) => [d.signal.cls, d.signal.path])).toEqual([['novel-key', 'brand_new']]);
  });

  test('a framed body is normalized and says how', () => {
    const { read, sink } = readWith('followers-list', { text: `for (;;);${JSON.stringify({ users: [], has_more: false })}` });
    expect(read).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'framing', at: '(body)', detail: 'guarded' }] });
    expect(sink.snapshot().tallies['followers-list']).toEqual({ normalized: 1 });
  });

  test('a sink that throws never breaks the read', () => {
    const sink = { read: () => { throw new Error('disk full'); }, drift: () => {} };
    const read = readBody('followers-list', json({ users: [], has_more: false }), { at: AT }, { doc: surface(), sink, hints: NO_HINTS });
    expect(read.ok).toBe(true);
    expect(readBody('followers-list', json({ users: [] }), { at: AT }, { doc: surface(), sink: NO_SINK, hints: NO_HINTS }).ok).toBe(true);
  });
});
