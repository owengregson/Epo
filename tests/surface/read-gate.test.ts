/**
 * One observed gate (spec §10.5): a wall is never drift, a 404 is absence evidence of its own kind,
 * and only a 2xx with a parseable media type is data.
 */
import { gateObserved } from '@/surface/read/gate';

const PARSEABLE = /json|javascript|multipart\/mixed/i;
const gate = (status: number, mime: string, head?: string) => gateObserved(status, mime, PARSEABLE, head);

test.each([
  [429, 'application/json', undefined, { kind: 'wall', family: 'rate-limited', via: 'http', status: 429 }],
  [503, 'text/html', undefined, { kind: 'wall', family: 'rate-limited', via: 'http', status: 503 }],
  [401, 'application/json', undefined, { kind: 'wall', family: 'auth', via: 'http', status: 401 }],
  [403, 'text/html', undefined, { kind: 'wall', family: 'auth', via: 'http', status: 403 }],
  [200, 'text/html; charset=utf-8', undefined, { kind: 'wall', family: 'rate-limited', via: 'html', status: 200 }],
  [200, 'application/json', '  <!DOCTYPE html>', { kind: 'wall', family: 'rate-limited', via: 'html', status: 200 }],
  [404, 'text/html', undefined, { kind: 'wall', family: 'rate-limited', via: 'html', status: 404 }],
  [404, 'application/json', undefined, { kind: 'http-absent' }],
  [400, 'application/json', undefined, { kind: 'not-data', status: 400, mime: 'application/json' }],
  [200, 'image/png', undefined, { kind: 'not-data', status: 200, mime: 'image/png' }],
  [200, 'application/json', '{"data":{}}', { kind: 'data' }],
  [200, 'text/javascript; charset=utf-8', undefined, { kind: 'data' }],
  [200, 'multipart/mixed', '--graphql', { kind: 'data' }],
])('HTTP %i %s (head %p)', (status, mime, head, want) => {
  expect(gate(status, mime, head)).toEqual(want);
});
