import { hasWebOrigin } from '@/shared/url-origin';

const canonical = 'https://www.example.test/';

test.each([
  'https://www.example.test/',
  'https://www.example.test/profile/?view=list#top',
  'https://WWW.EXAMPLE.TEST:443/profile/',
])('accepts parsed canonical origins: %s', (url) => {
  expect(hasWebOrigin(url, canonical)).toBe(true);
});

test.each([
  'https://unrelated.test/?next=https://www.example.test/',
  'https://unrelated.test/www.example.test/',
  'https://www.example.test.attacker.test/',
  'https://www.example.test@attacker.test/',
  'https://example.test/',
  'http://www.example.test/',
  'https://www.example.test:8443/',
  'blob:https://www.example.test/synthetic',
  'about:blank',
  'data:text/plain,https://www.example.test/',
  '/profile/',
  'malformed',
])('rejects a different or non-web origin: %s', (url) => {
  expect(hasWebOrigin(url, canonical)).toBe(false);
});

test.each(['malformed', 'about:blank', 'file:///tmp/fixture'])('fails closed on invalid expected origins: %s', (url) => {
  expect(hasWebOrigin(url, url)).toBe(false);
});

test('uses the supplied origin rather than a service-specific host', () => {
  expect(hasWebOrigin('http://local.test:8080/path', 'http://local.test:8080/')).toBe(true);
  expect(hasWebOrigin('http://local.test/path', 'http://local.test:8080/')).toBe(false);
});
