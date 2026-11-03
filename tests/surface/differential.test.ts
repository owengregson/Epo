/**
 * The differential test (spec §10.3): the legacy extractors and the surface document read every real
 * body of both corpora to the same projection, field by field. The two differ only where the document
 * is intended to differ — the synthetic drift bodies below, each with the fields it changes asserted.
 */
import { legacyComparable } from '@/adapter/reader-shadow';
import { routeOf } from '@/surface/index';
import { readBody } from '@/surface/read/read';
import type { SurfaceRead } from '@/surface/read/types';
import type { EndpointKind } from '@/surface/schema/endpoints';
import { comparableOf, diffProjections } from '@/surface/shadow';
import { setLevel } from '@/utils/logger';
import { bodyOf, CORPORA, hasCorpusAt, manifestOf } from './corpus';

beforeAll(() => setLevel('error'));

const AT = 1_786_534_400_000;
const PROFILE_OP = { 'x-fb-friendly-name': 'PolarisProfilePageContentQuery' };
const json = (v: unknown) => ({ decoded: { ok: true as const, json: v, format: 'json' as const, payloads: 1, final: null } });

/** The document's read and the legacy extractors' answer for one body, and the fields they differ on. */
function differential(kind: EndpointKind, body: unknown, ctx: { at: number; pk?: string; route?: ReturnType<typeof routeOf> }) {
  const read: SurfaceRead = readBody(kind, json(body), { at: ctx.at, ...(ctx.pk === undefined ? {} : { pk: ctx.pk }),
    ...(ctx.route === null || ctx.route === undefined ? {} : { route: ctx.route }) });
  const doc = comparableOf(read);
  const legacy = legacyComparable(kind, body, { at: ctx.at, pk: ctx.pk, viewerPk: read.ok ? read.projection.viewerPk : null });
  return { read, doc, legacy, diffs: doc === null || legacy === null ? null : diffProjections(doc, legacy) };
}

const real = [...CORPORA].filter(hasCorpusAt).flatMap((id) => {
  const m = manifestOf(id);
  return m.bodies.map((entry) => ({ id, entry, body: bodyOf(id, entry.file), at: m.replayAt }));
});

describe('every real body reads the same through both parsers', () => {
  test.each(real.map((c) => [`${c.id}/${c.entry.file}`, c] as const))('%s', (_name, { entry, body, at }) => {
    const r = entry.route;
    const route = r === undefined ? undefined
      : routeOf({ url: r.path, method: r.method, requestHeaders: r.op === null ? {} : { 'x-fb-friendly-name': r.op } });
    const { read, diffs } = differential(entry.endpoint, body, { at, pk: entry.pk, route });
    expect(read).toMatchObject({ ok: true, tier: 'canonical' });
    expect(diffs).toEqual([]);
  });
});

const row = (pk: unknown, over: Record<string, unknown> = {}) => ({ pk, pk_id: pk, id: pk, strong_id__: pk, username: `user_${String(pk)}`, ...over });
const page = (users: unknown[]) => ({ users, has_more: false, big_list: false });
const profileRoute = routeOf({ url: 'https://www.instagram.com/api/graphql', requestHeaders: PROFILE_OP });
const story = (type: unknown, args: Record<string, unknown>) => ({ story_type: type, args });
const inbox = (stories: unknown[]) => ({ new_stories: [], old_stories: stories });
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(String(i + 1)));

describe('the intended differences, each on a synthetic drift body', () => {
  test('a row whose ids disagree is quarantined, never read under one of them (I1)', () => {
    const { diffs, read } = differential('followers-list', page([...rows(10), row('99', { id: '98' })]), { at: AT });
    expect(diffs).toEqual(['facts.length', 'rows']);
    expect(read.ok && read.projection.rowIssues).toEqual([{ index: 10, path: 'id', message: 'id-conflict' }]);
  });

  test('a relationship map keyed by something that is not an id reads no fact for it (I1)', () => {
    const fs = { following: true, outgoing_request: false, incoming_request: false, is_private: false };
    const { diffs } = differential('show-many', { friendship_statuses: { '11': fs, ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [String(i + 20), fs])), not_an_id: fs } }, { at: AT });
    expect(diffs).toEqual(['relationships.length']);
  });

  test('an unsafe profile id is no profile (I1: a rounded number is never an id)', () => {
    const body = { data: { user: { pk: 2 ** 60, username: 'x', follower_count: 1, following_count: 2, is_private: false,
      is_verified: false, biography: '', friendship_status: null } } };
    const { doc, legacy } = differential('profile-graphql', body, { at: AT, route: profileRoute });
    expect(doc?.facts).toEqual([]);
    expect(legacy?.facts).toHaveLength(1);
  });

  test('a digit-string story type is retyped, so its follow is read (C1)', () => {
    const { diffs, read } = differential('activity-feed', inbox([story('101', { profile_id: '11', timestamp: 1_786_000_000 })]), { at: AT });
    expect(diffs).toEqual(['events.length']);
    expect(read).toMatchObject({ ok: true, tier: 'normalized', steps: [{ kind: 'retype' }] });
  });

  test('a follow story whose actor moved to an agreeing alias is read from it (C1)', () => {
    const { diffs, read } = differential('activity-feed',
      inbox([story(101, { inline_follow: { user_info: { pk: '13' } }, timestamp: 1_786_000_000 })]), { at: AT });
    expect(diffs).toEqual(['events.length']);
    expect(read.ok && read.projection.events).toEqual([{ pk: '13', username: null, atMs: 1_786_000_000_000 }]);
  });

  test('a time outside the plausible range reads as unknown, never as a wrong date (I9)', () => {
    const { diffs, read } = differential('activity-feed', inbox([story(101, { profile_id: '11', timestamp: 1_786_000_000_000 })]), { at: AT });
    expect(diffs).toEqual(['events[]']);
    expect(read.ok && read.projection.events).toEqual([{ pk: '11', username: null, atMs: null }]);
  });
});
