/**
 * Field readers and invariants (spec §10.3): ids from allow-listed keys only (I1, I2), counts as an
 * atomic pair with a declared retype (I5), epoch seconds in range (I9), presence for bio and flags,
 * and a null relationship that means "self" only for the viewer's own record (I10).
 */
import {
  readBool,
  readCountPair,
  readEpochSeconds,
  readId,
  readRelationshipPresence,
  readTextPresence,
} from '@/surface/read/fields';

const IDS = { idKeys: ['pk', 'pk_id', 'id', 'strong_id__'], foreignIdKeys: ['fbid_v2', 'fbid', 'interop_messaging_user_fbid'] };
const COUNTS = { followers: 'follower_count', following: 'following_count', mutuals: 'mutual_followers_count' };

describe('readId (I1, I2)', () => {
  test('the canonical key, as a decimal string or a positive safe integer', () => {
    expect(readId({ pk: '17841400000' }, IDS)).toEqual({ pk: '17841400000' });
    expect(readId({ pk: 700000000097 }, IDS)).toEqual({ pk: '700000000097' });
  });

  test('every present allow-listed key must agree; a conflict quarantines the row', () => {
    expect(readId({ pk: '12', pk_id: '12', id: '12', strong_id__: '12' }, IDS)).toEqual({ pk: '12' });
    expect(readId({ pk: '12', id: '13' }, IDS)).toEqual({ issue: { path: 'id', kind: 'id-conflict' } });
  });

  test('a canonical key that is absent falls back to agreeing aliases, as a normalized step', () => {
    expect(readId({ pk_id: '12', id: '12' }, IDS)).toEqual({ pk: '12', step: { kind: 'alias-key', at: 'pk_id' } });
    expect(readId({ pk_id: '12', id: '14' }, IDS)).toEqual({ issue: { path: 'id', kind: 'id-conflict' } });
  });

  test('a rounded unsafe number, a non-decimal string or another type never reads as an id', () => {
    expect(readId({ pk: 18446744073709552000 }, IDS)).toEqual({ issue: { path: 'pk', kind: 'unsafe-number', got: 'number' } });
    expect(readId({ pk: 'user_1' }, IDS)).toEqual({ issue: { path: 'pk', kind: 'id-space', got: 'string' } });
    expect(readId({ pk: '012' }, IDS)).toEqual({ issue: { path: 'pk', kind: 'id-space', got: 'string' } });
    expect(readId({ pk: true }, IDS)).toEqual({ issue: { path: 'pk', kind: 'invalid', got: 'boolean' } });
  });

  test('an invalid alias does not vote; foreign ids never vote (I2)', () => {
    expect(readId({ pk: '12', id: 'string', strong_id__: '12' }, IDS)).toEqual({ pk: '12' });
    expect(readId({ fbid_v2: '17841', interop_messaging_user_fbid: '9' }, IDS)).toEqual({
      issue: { path: 'pk', kind: 'expected-absent', got: 'absent' },
    });
  });
});

describe('readCountPair (I5)', () => {
  test('both counts read as a pair, mutuals only alongside', () => {
    expect(readCountPair({ follower_count: 781, following_count: 796, mutual_followers_count: 35 }, COUNTS)).toEqual({
      followers: 781, following: 796, mutuals: 35, steps: [],
    });
    expect(readCountPair({ follower_count: 1, following_count: 0, mutual_followers_count: null }, COUNTS)).toEqual({
      followers: 1, following: 0, steps: [],
    });
  });

  test('a digit-string count is retyped (normalized), never another kind', () => {
    expect(readCountPair({ follower_count: '1200', following_count: 4 }, COUNTS)).toEqual({
      followers: 1200, following: 4, steps: [{ kind: 'retype', at: 'follower_count', detail: 'string' }],
    });
    expect(readCountPair({ follower_count: '1.2K', following_count: 4 }, COUNTS)).toEqual({
      issue: { path: 'follower_count', kind: 'invalid', got: 'string' },
    });
  });

  test('a partial pair emits no stat', () => {
    expect(readCountPair({ follower_count: 10 }, COUNTS)).toEqual({ issue: { path: 'following_count', kind: 'counts-partial' } });
    expect(readCountPair({ following_count: 10, follower_count: null }, COUNTS)).toEqual({
      issue: { path: 'follower_count', kind: 'counts-partial' },
    });
  });

  test('negative, fractional or unsafe counts are invalid; a record with neither is no counts at all', () => {
    expect(readCountPair({ follower_count: -1, following_count: 1 }, COUNTS)).toMatchObject({ issue: { kind: 'invalid' } });
    expect(readCountPair({ follower_count: 1.5, following_count: 1 }, COUNTS)).toMatchObject({ issue: { kind: 'invalid' } });
    expect(readCountPair({ media_count: 3 }, COUNTS)).toBeNull();
  });
});

describe('readEpochSeconds (I9)', () => {
  const NOW = Date.UTC(2026, 10, 2);
  test('seconds in range become ms', () => {
    expect(readEpochSeconds(1_786_534_400.4, NOW)).toEqual({ ms: 1_786_534_400_400 });
  });
  test('a unit drift or an impossible time is a time-range issue, never a date', () => {
    expect(readEpochSeconds(1_786_534_400_400, NOW)).toEqual({ issue: { path: '', kind: 'time-range', got: 'number' } });
    expect(readEpochSeconds(1_000, NOW)).toMatchObject({ issue: { kind: 'time-range' } });
    expect(readEpochSeconds('1786534400', NOW, 'args.timestamp')).toEqual({
      issue: { path: 'args.timestamp', kind: 'time-range', got: 'string' },
    });
  });
});

describe('presence', () => {
  test('booleans: a value, or why there is none', () => {
    expect(readBool({ is_private: false }, 'is_private')).toEqual({ value: false });
    expect(readBool({}, 'is_private')).toEqual({ presence: 'absent' });
    expect(readBool({ is_private: null }, 'is_private')).toEqual({ presence: 'null' });
    expect(readBool({ is_private: 'false' }, 'is_private')).toEqual({ presence: 'invalid' });
  });

  test("text: '' and text both read; null and absent are kept apart", () => {
    expect(readTextPresence({ biography: '' }, 'biography')).toBe('read');
    expect(readTextPresence({ biography: 'hi' }, 'biography')).toBe('read');
    expect(readTextPresence({ biography: null }, 'biography')).toBe('null');
    expect(readTextPresence({}, 'biography')).toBe('absent');
    expect(readTextPresence({ biography: 3 }, 'biography')).toBe('invalid');
  });

  test('a null relationship is the viewer only on the viewer\'s own record (I10)', () => {
    expect(readRelationshipPresence({ friendship_status: null }, 'friendship_status', '7', '7')).toBe('self');
    expect(readRelationshipPresence({ friendship_status: null }, 'friendship_status', '7', '8')).toBe('null');
    expect(readRelationshipPresence({ friendship_status: null }, 'friendship_status', '7', null)).toBe('null');
    expect(readRelationshipPresence({ friendship_status: {} }, 'friendship_status', '7', '8')).toBe('read');
    expect(readRelationshipPresence({}, 'friendship_status', '7', '8')).toBe('absent');
  });
});
