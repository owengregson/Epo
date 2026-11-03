/**
 * The typed live activity (F2a step 5). Phase F identity: `toVeilInfo` gives
 * the veil exactly the seven payloads the reporter sites sent before the type
 * change (the sidebar stream later rewrites this test with one wording).
 */
import { type ActivityInfo, liveOpText, toVeilInfo } from '@/shared/live-op';

/** Today's seven reporter payloads, as each site built them (key order included). */
const TODAY: ReadonlyArray<[ActivityInfo, unknown]> = [
  [{ kind: 'page', op: { op: 'follow', username: 'jane' } }, { kind: 'page', label: 'Following @jane' }],
  [{ kind: 'page', op: { op: 'unfollow', username: 'carl' } }, { kind: 'page', label: 'Unfollowing @carl' }],
  [{ kind: 'page', op: { op: 'open-list', list: 'followers', of: 'studio' } },
    { kind: 'page', label: 'Opening followers list · @studio' }],
  [{ kind: 'page', op: { op: 'open-list', list: 'following', of: 'studio' } },
    { kind: 'page', label: 'Opening following list · @studio' }],
  [{ kind: 'page', op: { op: 'check-notifications' } }, { kind: 'page', label: 'Checking notifications' }],
  [{ kind: 'page', op: { op: 'visit-profiles', done: 2, total: 5 } },
    { kind: 'page', label: 'Visiting profiles', count: 2, total: 5 }],
  [{ kind: 'page', op: { op: 'browse-list', list: 'followers', of: 'studio', done: 7, total: null } },
    { kind: 'page', label: 'Scrolling follower list', count: 7, detail: '@studio' }],
  [{ kind: 'page', op: { op: 'browse-list', list: 'following', of: 'studio', done: 0, total: null } },
    { kind: 'page', label: 'Scrolling following list', count: 0, detail: '@studio' }],
  [{ kind: 'api', op: { op: 'read-list', list: 'followers', of: null, done: 3, total: null } },
    { kind: 'api', label: 'Reading follower list', count: 3 }],
  [{ kind: 'api', op: { op: 'read-list', list: 'following', of: null, done: 4, total: 10 } },
    { kind: 'api', label: 'Reading following list', count: 4, total: 10 }],
];

test.each(TODAY)('toVeilInfo keeps today\'s veil payload: %j', (info, payload) => {
  expect(JSON.stringify(toVeilInfo(info))).toBe(JSON.stringify(payload));
});

test('ops with no reporter site yet show their plain sentence on the veil', () => {
  expect(toVeilInfo({ kind: 'page', op: { op: 'open-own-profile' } })).toEqual({ kind: 'page', label: 'Opening your profile' });
});

test('liveOpText says one plain sentence per op', () => {
  expect(liveOpText({ op: 'follow', username: 'jane' })).toBe('Following @jane');
  expect(liveOpText({ op: 'accept-request', username: 'dana' })).toBe("Accepting @dana's follow request");
  expect(liveOpText({ op: 'open-list', list: 'followers', of: 'studio.lumen' })).toBe("Opening @studio.lumen's followers");
  expect(liveOpText({ op: 'browse-list', list: 'followers', of: 'studio.lumen', done: 120, total: null }))
    .toBe("Scrolling @studio.lumen's followers · 120");
  expect(liveOpText({ op: 'read-list', list: 'followers', of: 'studio.lumen', done: 120, total: 250 }))
    .toBe("Reading @studio.lumen's followers · 120 of 250");
  expect(liveOpText({ op: 'read-list', list: 'followers', of: null, done: 1_200, total: null }))
    .toBe('Reading your followers · 1,200');
  expect(liveOpText({ op: 'visit-profiles', done: 3, total: 20 })).toBe('Looking at profiles · 3 of 20');
  expect(liveOpText({ op: 'visit-profile', username: 'bob', purpose: 'check-back' }))
    .toBe('Checking whether @bob follows you back');
  expect(liveOpText({ op: 'visit-profile', username: 'bob', purpose: 'verify' })).toBe('Double-checking @bob before acting');
  expect(liveOpText({ op: 'visit-profile', username: 'bob', purpose: 'settle' })).toBe('Confirming what happened with @bob');
  expect(liveOpText({ op: 'visit-profile', username: 'bob', purpose: 'seed' })).toBe('Checking @bob');
  expect(liveOpText({ op: 'check-notifications' })).toBe('Checking your notifications');
  expect(liveOpText({ op: 'confirm-account' })).toBe('Confirming your account');
});
