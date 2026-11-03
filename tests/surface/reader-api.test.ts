/**
 * The Reader over `readBody` (spec Appendix D.1): `read` with the Reader's env, `profileSeen` (own
 * counts and viewer flags only from a C0/C1 complete read) and `relationshipFacts` (minted from a read).
 */
import { Reader } from '@/adapter/reader';
import type { SurfaceRead } from '@/surface/read/types';
import { MemorySink } from '@/surface/sink';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const route = { url: 'https://www.instagram.com/api/graphql', requestHeaders: { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' } };
const body = (fs: unknown, extra: Record<string, unknown> = {}) => ({
  data: { user: { pk: '42', id: '42', username: 'own', biography: 'b', follower_count: 10, following_count: 20, is_private: false,
    is_verified: false, friendship_status: fs }, viewer: { user: { pk: '42', id: '42' } } }, ...extra,
});
const FS = { following: false, outgoing_request: false, followed_by: false, incoming_request: false };

const sink = new MemorySink();
const reader = new Reader({ sink });
const read = (b: unknown, final: boolean | null = null): SurfaceRead =>
  reader.read('profile-graphql', { decoded: { ok: true, json: b, format: 'json', payloads: 1, final } },
    { at: AT, route: reader.route(route) ?? undefined });

describe('Reader.profileSeen', () => {
  test('a canonical complete read keeps our own counts and the viewer flags', () => {
    const seen = reader.profileSeen(read(body(FS)), '42');
    expect(seen).toMatchObject({ tier: 'canonical', partial: false, obs: { fields: { followers: 10, following: 20 } },
      viewer: { following: false, requested: false, followsUs: false, incomingRequest: false } });
  });

  test('a partial read drops our own counts and withholds every viewer flag', () => {
    const seen = reader.profileSeen(read(body(FS, { errors: [{ message: 'x' }] })), '42');
    expect(seen).toMatchObject({ partial: true, obs: { fields: { followers: undefined, following: undefined } },
      viewer: { following: null, requested: null, followsUs: null, incomingRequest: null } });
    // Another account's counts are additive: kept.
    expect(reader.profileSeen(read(body(FS, { errors: [{ message: 'x' }] })), '7')?.obs.fields.followers).toBe(10);
  });

  test('a failed read, or one with no record, is no profile', () => {
    expect(reader.profileSeen(read({ status: 'fail' }), '42')).toBeNull();
    expect(reader.profileSeen(read({ data: { user: null } }), '42')).toBeNull();
  });
});

describe('Reader.relationshipFacts(read)', () => {
  test('both keys present and false: weFollow false, from a destructive-admitted read only', () => {
    expect(reader.relationshipFacts(read(body(FS)))).toEqual([{ pk: '42', weFollow: false }]);
    expect(reader.relationshipFacts(read(body(FS), false))).toEqual([]);
  });

  test('a renamed key is unknown: no fact; a true key is a guarded fact', () => {
    expect(reader.relationshipFacts(read(body({ following: false, followed_by: false })))).toEqual([]);
    expect(reader.relationshipFacts(read(body({ ...FS, following: true })))).toEqual([{ pk: '42', weFollow: true }]);
  });

  test('the Reader\'s sink heard every read', () => {
    expect(sink.snapshot().tallies['profile-graphql']?.canonical).toBeGreaterThan(0);
  });
});
