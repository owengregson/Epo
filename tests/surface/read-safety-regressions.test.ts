/** Safety differences established before the legacy comparator was retired (spec §10.3, S8). */
import { Reader } from '@/adapter/reader';
import { setLevel } from '@/utils/logger';
import { PROFILE_QUERY, readAs } from '../kit/surface';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const reader = new Reader();
const row = (pk: unknown, over: Record<string, unknown> = {}) => ({ pk, pk_id: pk, id: pk, strong_id__: pk, username: `user_${String(pk)}`, ...over });
const page = (users: unknown[]) => ({ users, has_more: false, big_list: false });
const story = (type: unknown, args: Record<string, unknown>) => ({ story_type: type, args });
const inbox = (stories: unknown[]) => ({ new_stories: [], old_stories: stories });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(String(i + 1)));

test('a row whose ids disagree is quarantined, never read under one of them (I1)', () => {
  const read = readAs(reader, 'followers-list', page([...rows(10), row('99', { id: '98' })]), { at: AT });
  expect(read.ok && read.projection.rowIssues).toEqual([{ index: 10, path: 'id', message: 'id-conflict' }]);
  expect(read.ok && read.projection.facts.map((f) => f.accountPk)).toEqual(rows(10).map((r) => r.pk));
});

test('a relationship map keyed by something that is not an id reads no fact for it (I1)', () => {
  const fs = { following: true, outgoing_request: false, incoming_request: false, is_private: false };
  const ids = ['11', ...Array.from({ length: 9 }, (_, i) => String(i + 20))];
  const read = readAs(reader, 'show-many', { friendship_statuses: {
    ...Object.fromEntries(ids.map((id) => [id, fs])), not_an_id: fs,
  } }, { at: AT });
  expect(read.ok && read.projection.relationships.map((r) => r.pk)).toEqual(ids);
});

test('an unsafe profile id is no profile (I1: a rounded number is never an id)', () => {
  const body = { data: { user: { pk: 2 ** 60, username: 'x', follower_count: 1, following_count: 2, is_private: false,
    is_verified: false, biography: '', friendship_status: null } } };
  const read = readAs(reader, 'profile-graphql', body, { at: AT }, PROFILE_QUERY);
  expect(read.ok && read.projection.facts).toEqual([]);
});

test('a digit-string story type is retyped, so its follow is read (C1)', () => {
  const read = readAs(reader, 'activity-feed', inbox([story('101', { profile_id: '11', timestamp: 1_786_000_000 })]), { at: AT });
  expect(read).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'retype' }] });
  expect(read.ok && read.projection.events).toEqual([{ pk: '11', username: null, atMs: 1_786_000_000_000 }]);
});

test('a follow story whose actor moved to an agreeing alias is read from it (C1)', () => {
  const read = readAs(reader, 'activity-feed',
    inbox([story(101, { inline_follow: { user_info: { pk: '13' } }, timestamp: 1_786_000_000 })]), { at: AT });
  expect(read.ok && read.projection.events).toEqual([{ pk: '13', username: null, atMs: 1_786_000_000_000 }]);
});

test('a time outside the plausible range reads as unknown, never as a wrong date (I9)', () => {
  const read = readAs(reader, 'activity-feed', inbox([story(101, { profile_id: '11', timestamp: 1_786_000_000_000 })]), { at: AT });
  expect(read.ok && read.projection.events).toEqual([{ pk: '11', username: null, atMs: null }]);
});
