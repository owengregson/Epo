import { arbitrate } from '@/adapter/arbiter';
import { ActionBlockedError } from '@/adapter/errors';
import { MutationWatch } from '@/adapter/mutation-watch';
import { settledResult } from '@/adapter/unfollow-flow';
import { FakeTab, mkResp } from '../kit/fakes';

const FOLLOW_URL = 'https://www.instagram.com/api/v1/web/friendships/123/follow/';

test.each([
  [429, 'application/json', 'rate-limited'], [500, 'application/json', 'rate-limited'],
  [401, 'application/json', 'auth'], [403, 'application/json', 'auth'],
  [404, 'application/json', 'refused'], [200, 'text/html', 'rate-limited'],
])('matched mutation status %s / %s takes precedence over a success-shaped body', async (status, mime, kind) => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  const base = mkResp(FOLLOW_URL, { status: 'ok', result: 'following' });
  const getBody = jest.fn(base.getBody);
  tab.emit({ ...base, method: 'POST', status: status as number, mimeType: mime as string, getBody });
  expect((await watch.next(0))?.classification.kind).toBe(kind);
  expect(getBody).not.toHaveBeenCalled();
  watch.dispose();
});

test('an HTML wall mislabeled as JSON remains a wall after the body is decoded', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  tab.emit({ ...mkResp(FOLLOW_URL, {}), method: 'POST', getBody: async () => '<html>Try again later</html>' });
  expect((await watch.next(0))?.classification.kind).toBe('rate-limited');
  watch.dispose();
});


test('an exchange-level errors body cannot be promoted to landed by an optimistic DOM flip', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  tab.emit({ ...mkResp(FOLLOW_URL, { status: 'ok', errors: [{ message: 'Unknown exchange failure' }] }), method: 'POST' });
  const observed = await watch.next(0);
  const verdict = await arbitrate({ op: 'follow', label: 'test.follow', observed, watchAvailable: true, latencyMs: 0,
    verifyPostState: async () => true, probeBlock: async () => null, now: () => 1 });
  expect(verdict).toMatchObject({ kind: 'refused' });
  expect(() => settledResult(verdict, 'test.follow', 'someone')).toThrow(ActionBlockedError);
  watch.dispose();
});


test('an unrecognized mutation candidate with mislabeled HTML remains a wall', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  tab.emit({ ...mkResp('https://www.instagram.com/api/graphql', '<html>Try again later</html>',
    { 'x-fb-friendly-name': 'usePolarisFriendshipCreateMutation' }), method: 'POST' });
  expect(await watch.next(0)).toMatchObject({ via: 'candidate', classification: { kind: 'rate-limited' } });
  watch.dispose();
});

test('a non-data media type never contributes a success verdict', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  const getBody = jest.fn(async () => JSON.stringify({ status: 'ok' }));
  tab.emit({ ...mkResp(FOLLOW_URL, {}), method: 'POST', mimeType: 'text/plain', getBody });
  expect((await watch.next(0))?.classification.kind).toBe('drift-suspect');
  expect(getBody).not.toHaveBeenCalled();
  watch.dispose();
});

test('a success-shaped 400 is a refusal, even when the DOM flips optimistically', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  tab.emit({ ...mkResp(FOLLOW_URL, { status: 'ok' }), method: 'POST', status: 400 });
  const observed = await watch.next(0);
  expect((await arbitrate({ op: 'follow', label: 'test', observed, watchAvailable: true, latencyMs: 0,
    verifyPostState: async () => true, probeBlock: async () => null, now: () => 1 })).kind).toBe('refused');
  watch.dispose();
});

test('a non-final mutation answer remains unverified despite an optimistic DOM flip', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('unfollow', 'test.unfollow', tab);
  tab.emit({ ...mkResp(FOLLOW_URL.replace('/follow/', '/unfollow/'),
    { status: 'ok', extensions: { is_final: false } }), method: 'POST' });
  const observed = await watch.next(0);
  const verdict = await arbitrate({ op: 'unfollow', label: 'test', observed, watchAvailable: true, latencyMs: 0,
    verifyPostState: async () => true, probeBlock: async () => null, now: () => 1 });
  expect(verdict).toMatchObject({ kind: 'ambiguous', effect: 'mark-unverified' });
  expect(settledResult(verdict, 'test.unfollow', 'someone').ok).toBe(false);
  watch.dispose();
});

test('a final authoritative answer can follow an incomplete body on the same armed watch', async () => {
  const tab = new FakeTab();
  const watch = new MutationWatch('follow', 'test.follow', tab);
  tab.emit({ ...mkResp(FOLLOW_URL, { status: 'ok', extensions: { is_final: false } }), method: 'POST' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(watch.peek()?.classification).toMatchObject({ partial: true });
  tab.emit({ ...mkResp(FOLLOW_URL, { status: 'ok', extensions: { is_final: true } }), method: 'POST' });
  const observed = await watch.next(0);
  expect(observed?.classification.kind).toBe('ok');
  expect(observed?.classification.partial).toBeUndefined();
  watch.dispose();
});
