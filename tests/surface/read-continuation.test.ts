/**
 * List continuation (spec §10.4): what a page says about the rest of the list, read in a fixed
 * rule order, and never "safe either way". Every real end page reads `end{flags-false}`, unvetoed.
 */
import { continuationOf } from '@/surface/read/continuation';
import { CONTINUATION } from '@/surface/versions/2026-08-12/continuation-decl';
import { body, hasCorpus, manifest } from './corpus';

const read = (page: Record<string, unknown>, final: boolean | null = null) =>
  continuationOf(page, CONTINUATION, { final });
const users = [{ pk: '1', username: 'a' }];

describe('continuationOf: the rules, in order', () => {
  test('a stream that says it is not final is drift, whatever else the page says', () => {
    expect(read({ users, next_max_id: '50', has_more: true }, false).continuation).toEqual({
      kind: 'drift', reason: 'incomplete-stream',
    });
  });

  test('a non-empty string cursor continues; digits are an offset, anything else opaque', () => {
    expect(read({ users, next_max_id: '50', has_more: false }).continuation).toEqual({ kind: 'next', cursor: '50', form: 'offset' });
    expect(read({ users, next_max_id: 'QVFE…' }).continuation).toEqual({ kind: 'next', cursor: 'QVFE…', form: 'opaque' });
    expect(read({ users, next_max_id: '1234567890' }).continuation).toMatchObject({ form: 'opaque' });
  });

  test('a safe-integer cursor is retyped to its string (a normalized step), never dropped', () => {
    const out = read({ users, next_max_id: 50 });
    expect(out.continuation).toEqual({ kind: 'next', cursor: '50', form: 'offset' });
    expect(out.steps).toEqual([{ kind: 'retype', at: 'next_max_id', detail: 'number' }]);
    expect(read({ users, next_max_id: 2 ** 60 }).continuation.kind).not.toBe('next');
  });

  test('no cursor but a more-flag set is drift, naming the flag', () => {
    expect(read({ users, has_more: true }).continuation).toEqual({ kind: 'drift', reason: 'more-without-cursor', key: 'has_more' });
    expect(read({ users, next_max_id: '', has_more: false, big_list: true }).continuation).toEqual({
      kind: 'drift', reason: 'more-without-cursor', key: 'big_list',
    });
  });

  test('no cursor with flags present and all false is an end on the server flags', () => {
    expect(read({ users, has_more: false, big_list: false }).continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
    expect(read({ users, next_max_id: null, big_list: false }).continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
  });

  test('no cursor and no flag at all is an end without evidence', () => {
    expect(read({ users }).continuation).toEqual({ kind: 'end', evidence: 'no-flags' });
  });
});

describe('vetoKey names the first unexplained cursor-like root key', () => {
  test.each([
    ['a non-empty string', { next_cursor: 'QVFE' }, 'next_cursor'],
    ['a finite number', { offset_hint: 100 }, 'offset_hint'],
    ['true under a more/next name', { more_available: true }, 'more_available'],
    ['an object holding a cursor-named key', { paging: { after: 'x' } }, 'paging'],
    ['an array whose rows hold one two levels down', { pages: [{ info: { end_cursor: 'x' } }] }, 'pages'],
  ])('%s', (_name, extra, key) => {
    expect(read({ users, has_more: false, ...extra }).continuation).toEqual({ kind: 'end', evidence: 'flags-false', vetoKey: key });
  });

  test('explained and declared keys never veto, nor do plain flags and empty containers', () => {
    const page = { users, has_more: false, page_size: 50, status: 'ok', follow_ranking_token: 'tok', groups: [],
      friend_requests: {}, is_new: false, extra: { deeply: { nested: { end_cursor: 'x' } } } };
    expect(read(page).continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
  });
});

const listBodies = hasCorpus()
  ? manifest().bodies.filter((b) => /^(followers|following)-list$|^friend-requests$/.test(b.endpoint))
  : [];

describe('the committed corpus', () => {
  test('carries list pages to check', () => {
    expect(listBodies.length).toBeGreaterThan(0);
  });

  test.each(listBodies.map((b) => [b.file, b] as const))('%s: every root key is declared or explained', (_f, entry) => {
    const known = new Set([...CONTINUATION.cursorKeys, ...CONTINUATION.moreFlags, ...CONTINUATION.explainedPageKeys]);
    expect(Object.keys(body(entry.file) as object).filter((k) => !known.has(k))).toEqual([]);
  });

  test.each(listBodies.map((b) => [b.file, b] as const))('%s: an end page is flags-false, unvetoed', (_f, entry) => {
    const { continuation } = read(body(entry.file) as Record<string, unknown>);
    if (entry.expect.cursor !== null) expect(continuation).toEqual({ kind: 'next', cursor: entry.expect.cursor, form: expect.any(String) });
    else expect(continuation).toEqual({ kind: 'end', evidence: 'flags-false' });
  });
});
