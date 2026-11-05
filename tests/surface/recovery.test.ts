/**
 * Structural recovery (spec §10.6): the bounded locator (R1–R7) and the C2 read over it. The laws:
 * L-RECOVER-C2 (a recovered read is never destructive), L-ANCHOR (a profile is located only as its
 * anchor's own record), L-DECOY (a declared decoy container is never located).
 */
import { Reader } from '@/adapter/reader';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { surface } from '@/surface/index';
import { recoverBody } from '@/surface/read/recover';
import type { ReadCtx } from '@/surface/read/types';
import { type LocateInput, locate } from '@/surface/recovery/locate';
import { usernameFieldOf } from '@/surface/recovery/signatures';
import { MemorySink } from '@/surface/sink';
import type { Decoded } from '@/surface/transport/decode';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const decl = surface().read.recovery;
const decoded = (json: unknown): Decoded => ({ ok: true, json, format: 'json', payloads: 1, final: null });
const record = (pk: string, username: string, over: Record<string, unknown> = {}) => ({
  pk, id: pk, username, biography: 'bio', follower_count: 10, following_count: 20, is_private: false, is_verified: false,
  friendship_status: { following: false, outgoing_request: false, followed_by: false, incoming_request: false }, ...over,
});
const row = (pk: string, over: Record<string, unknown> = {}) => ({ pk, pk_id: pk, id: pk, username: `user_${pk}`, ...over });
const rows = (n: number, from = 1, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => row(String(from + i), over));
const input = (over: Partial<LocateInput>): LocateInput =>
  ({ role: 'profile-user', endpoint: 'profile-graphql', body: {}, bodyBytes: 0, decl, hints: [], ...over });
const visit = (username: string, pk?: string): Pick<ReadCtx, 'arm' | 'anchor'> =>
  ({ arm: 'visit', anchor: { username, ...(pk === undefined ? {} : { pk }) } });

describe('locate: bounded, witnessed, one place (R1–R7)', () => {
  test('R1 a body above the byte bound is never searched', () => {
    expect(locate(input({ bodyBytes: SURFACE_BOUNDS.searchMaxBytes + 1, ...visit('subject') }))).toMatchObject({ ok: false, reason: 'too-large' });
  });

  test('R3 every role needs its witness: an arm, and the anchor it names', () => {
    expect(locate(input({ arm: 'drawer' }))).toMatchObject({ ok: false, reason: 'arm-required' });
    expect(locate(input({ arm: 'visit' }))).toMatchObject({ ok: false, reason: 'anchor-required' });
    expect(locate(input({ role: 'source-rows', endpoint: 'followers-list', arm: 'acquisition' })))
      .toMatchObject({ ok: false, reason: 'anchor-required' });
  });

  test('a record whose container was renamed is found under its anchor', () => {
    const body = { data: { user_v2: record('42', 'subject') } };
    expect(locate(input({ body, ...visit('subject', '42') }))).toMatchObject({ ok: true, path: 'data.user_v2', pattern: 'data.user_v2', via: 'search' });
  });

  test('L-ANCHOR: another account is never located as the anchor; a known pk must agree', () => {
    const body = { data: { user_v2: record('42', 'subject') } };
    expect(locate(input({ body, ...visit('someone_else') }))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(locate(input({ body, ...visit('subject', '43') }))).toMatchObject({ ok: false, reason: 'not-found' });
  });

  test('I4 a same-handle copy with another id makes the place ambiguous, never a guess', () => {
    const body = { data: { user_v2: record('42', 'subject'), embedded: { pk: '99', username: 'subject' } } };
    expect(locate(input({ body, ...visit('subject') }))).toMatchObject({ ok: false, reason: 'identity-conflict' });
  });

  test('R4 two places holding the record are ambiguous', () => {
    const body = { data: { a: record('42', 'subject'), b: record('42', 'subject') } };
    expect(locate(input({ body, ...visit('subject') }))).toMatchObject({ ok: false, reason: 'ambiguous', candidates: 2 });
  });

  test('R5 rows by majority; an empty array never matches', () => {
    const acq = { role: 'source-rows', endpoint: 'followers-list', arm: 'acquisition', anchor: { pk: '7' } } as const;
    expect(locate(input({ ...acq, body: { items: rows(10) } }))).toMatchObject({ ok: true, pattern: 'items' });
    expect(locate(input({ ...acq, body: { items: [] } }))).toMatchObject({ ok: false, reason: 'not-found' });
    expect(locate(input({ ...acq, body: { items: [...rows(2), { nope: 1 }, { nope: 2 }] } }))).toMatchObject({ ok: false, reason: 'not-found' });
  });

  test('L-DECOY: a declared suggestion container is never located, even when it is the only rows there are', () => {
    const acq = { role: 'source-rows', endpoint: 'followers-list', arm: 'acquisition', anchor: { pk: '7' } } as const;
    expect(locate(input({ ...acq, body: { items: rows(10), suggested_users: rows(10, 100) } }))).toMatchObject({ ok: true, pattern: 'items' });
    expect(locate(input({ ...acq, body: { suggested_users: rows(10, 100) } }))).toMatchObject({ ok: false, reason: 'not-found' });
  });

  test('R6 a learned place is tried first; one that no longer holds the record is reported contradicted', () => {
    const body = { data: { user_v3: record('42', 'subject') } };
    expect(locate(input({ body, hints: ['data.user_v3'], ...visit('subject') }))).toMatchObject({ ok: true, via: 'hint' });
    const moved = { data: { user_v2: { note: 'moved on' }, user_v3: record('42', 'subject') } };
    expect(locate(input({ body: moved, hints: ['data.user_v2'], ...visit('subject') })))
      .toMatchObject({ ok: true, via: 'search', pattern: 'data.user_v3', contradictedHint: 'data.user_v2' });
    // A learned place that no longer exists is no contradiction, only a miss.
    expect(locate(input({ body, hints: ['data.user_v9'], ...visit('subject') }))).not.toHaveProperty('contradictedHint');
  });

  test('R7 recovered rows the store knows under other usernames are an identity conflict; a profile anchor is not', () => {
    const acq = { role: 'source-rows', endpoint: 'followers-list', arm: 'acquisition', anchor: { pk: '7' } } as const;
    const body = { items: rows(10) };
    const renamed = { usernameOf: (pk: string) => (pk === '1' ? 'renamed_since' : pk === '2' ? 'user_2' : undefined) };
    expect(locate(input({ ...acq, body, identity: renamed }))).toMatchObject({ ok: false, reason: 'identity-conflict' });
    expect(locate(input({ ...acq, body, identity: { usernameOf: (pk: string) => `user_${pk}` } }))).toMatchObject({ ok: true });
    const profile = { data: { user_v2: record('42', 'subject') } };
    expect(locate(input({ body: profile, identity: { usernameOf: () => 'old_name' }, ...visit('subject') }))).toMatchObject({ ok: true });
  });

  test('R1 a pattern never carries an id: an id-keyed map renders as `*`', () => {
    const body = { data: { by_id: { '1234567': record('42', 'subject') } } };
    expect(locate(input({ body, ...visit('subject') }))).toMatchObject({ ok: true, pattern: 'data.by_id.*' });
    expect(locate(input({ body, hints: ['data.by_id.*'], ...visit('subject') }))).toMatchObject({ ok: true, via: 'hint' });
  });

  test('R1 the node budget bounds a pathological body', () => {
    const wide = Object.fromEntries(Array.from({ length: SURFACE_BOUNDS.searchMaxNodes + 1 }, (_, i) => [`k${i}`, i]));
    expect(locate(input({ body: wide, ...visit('subject') }))).toMatchObject({ ok: false, reason: 'budget' });
  });

  test('username-field: exactly one top-level field carries the anchor name', () => {
    expect(usernameFieldOf({ handle_v2: 'subject', other: 'x' }, { username: 'subject' })).toBe('handle_v2');
    expect(usernameFieldOf({ a: 'subject', b: 'subject' }, { username: 'subject' })).toBeNull();
  });
});

describe('L-RECOVER-C2: a recovered read adds facts and is never destructive', () => {
  const reader = (sink = new MemorySink()) => new Reader({ sink });

  test('a profile under a renamed container: observation fields, no relationship fact, our own counts dropped', () => {
    const sink = new MemorySink();
    const r = reader(sink);
    const read = r.recover('profile-graphql', decoded({ data: { user_v2: record('42', 'subject') } }), { at: AT, ...visit('subject', '42') });
    expect(read).toMatchObject({ ok: true, tier: 'recovered', located: { role: 'profile-user', pattern: 'data.user_v2', via: 'search' } });
    expect(r.relationshipFacts(read)).toEqual([]);
    expect(r.profileSeen(read, '42')).toMatchObject({ tier: 'recovered', obs: { fields: { followers: undefined, username: 'subject' } },
      viewer: { following: null, requested: null, followsUs: null, incomingRequest: null } });
    expect(r.profileSeen(read, '7')?.obs.fields.followers).toBe(10);
    expect(sink.snapshot().drift.map((d) => [d.signal.cls, d.signal.hint])).toContainEqual(
      ['recovered', { role: 'profile-user', pattern: 'data.user_v2', subject: '42', agreed: true }]);
  });

  test('username-field: a record that lost only its username reads at C2 from the one field carrying it', () => {
    const { username: _u, ...rest } = record('42', 'subject');
    const read = reader().recover('profile-graphql', decoded({ data: { user: { ...rest, handle_v2: 'subject' } } }),
      { at: AT, ...visit('subject', '42') });
    expect(read).toMatchObject({ ok: true, tier: 'recovered', located: { role: 'username-field', pattern: 'handle_v2' },
      projection: { facts: [{ fields: { username: 'subject' } }] } });
  });

  test('rows: a source page whose rows moved feeds rows only — the continuation is never recovered', () => {
    const read = reader().recover('followers-list', decoded({ items: rows(10), next_max_id: '50', has_more: true }),
      { at: AT, arm: 'acquisition', anchor: { pk: '7' } });
    expect(read).toMatchObject({ ok: true, tier: 'recovered', projection: { continuation: null, cursor: null } });
    expect(read.ok && read.projection.facts).toHaveLength(10);
  });

  test('requester rows need the incoming-request marker (I8)', () => {
    const marked = rows(10, 1, { friendship_status: { incoming_request: true } });
    const ok = reader().recover('friend-requests', decoded({ data: { moved: { edges: marked.map((node) => ({ node })) } } }),
      { at: AT, arm: 'requests-panel' });
    expect(ok).toMatchObject({ ok: true, tier: 'recovered' });
    expect(ok.ok && ok.projection.facts).toHaveLength(10);
    expect(reader().recover('friend-requests', decoded({ data: { moved: { edges: rows(10).map((node) => ({ node })) } } }),
      { at: AT, arm: 'requests-panel' })).toMatchObject({ ok: false });
  });

  test('own lists, relationship checks and every un-armed read are never recovered', () => {
    const body = decoded({ items: rows(10) });
    for (const kind of ['following-list', 'show-many', 'friendship-show'] as const) {
      expect(recoverBody(kind, body, { at: AT, arm: 'acquisition', anchor: { pk: '7' } })).toMatchObject({ ok: false });
    }
    expect(recoverBody('followers-list', body, { at: AT })).toMatchObject({ ok: false });
  });
});
