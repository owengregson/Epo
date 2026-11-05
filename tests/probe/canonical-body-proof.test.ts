import type { Exchange } from '@/probe/recorder';
import { hasCanonicalBody } from '@/probe/verify-evidence';

const request: Exchange = { n: 1, requestId: 'shared', sessionId: '', url: 'https://www.instagram.com/api/graphql',
  startedAt: 0, at: 0, step: 'drawer', method: 'POST', host: 'www.instagram.com', path: '/api/graphql',
  query: {}, headers: {}, epoKind: 'activity-feed' };
const body = { requestId: 'shared', kind: 'activity-feed', tier: 'canonical', partial: false };

test('one canonical root-session read certifies only its own unique request', () => {
  expect(hasCanonicalBody([request], 1, 'activity-feed', [body])).toBe(true);
  expect(hasCanonicalBody([request], 2, 'activity-feed', [body])).toBe(false);
  expect(hasCanonicalBody([request], 1, 'friend-requests', [body])).toBe(false);
  expect(hasCanonicalBody([request], 1, 'activity-feed', [{ ...body, partial: true }])).toBe(false);
});

test('a root-session read cannot certify a different debugger session with the same request ID', () => {
  const child = { ...request, n: 2, sessionId: 'child' };
  expect(hasCanonicalBody([child], 2, 'activity-feed', [body])).toBe(false);
  expect(hasCanonicalBody([request, child], 1, 'activity-feed', [body])).toBe(false);
  expect(hasCanonicalBody([request, child], 2, 'activity-feed', [body])).toBe(false);
});
