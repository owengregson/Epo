import { Reader } from '@/adapter/reader';
import { MemorySink } from '@/surface/sink';
import { mkResp } from '../kit/fakes';

const body = { data: { user: { pk: '42', id: '42', username: 'own', biography: '',
  follower_count: 10, following_count: 20, is_private: false, is_verified: false,
  friendship_status: { following: true, outgoing_request: false, followed_by: false, incoming_request: false } } } };
const anchor = { pk: '42', username: 'own' };
const response = (status = 200, mimeType = 'application/json') => {
  const base = mkResp('https://www.instagram.com/api/graphql', body, { 'x-fb-friendly-name': 'FutureUserProfileQuery' });
  return { ...base, status, mimeType, getBody: jest.fn(base.getBody) };
};

test.each([
  [429, 'application/json'], [500, 'application/json'], [401, 'application/json'], [403, 'application/json'],
  [404, 'application/json'], [302, 'application/json'], [200, 'text/html'], [200, 'text/plain'],
])('unrouted candidates reject status %s / %s before reading or recovering their bodies', async (status, mimeType) => {
  const reader = new Reader({ sink: new MemorySink() });
  const armed = reader.observed.arm('visit');
  const resp = response(status as number, mimeType as string);
  reader.observed.offer(resp);
  expect(await armed.recover(anchor)).toBeNull();
  expect(resp.getBody).not.toHaveBeenCalled();
  armed.dispose();
});

test('a valid unrouted candidate is recoverable, with one body read shared across repeated armed reads', async () => {
  const reader = new Reader({ sink: new MemorySink() });
  const first = reader.observed.arm('visit');
  const second = reader.observed.arm('visit');
  const resp = response();
  reader.observed.offer(resp);
  expect(await first.recover(anchor)).toMatchObject({ ok: true, tier: 'recovered' });
  expect(await second.recover(anchor)).toMatchObject({ ok: true, tier: 'recovered' });
  expect(resp.getBody).toHaveBeenCalledTimes(1);
  first.dispose(); second.dispose();
});
