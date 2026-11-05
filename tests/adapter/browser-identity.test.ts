import { browserUserAgent } from '@/adapter/browser-identity';

test.each([
  'Macintosh; Intel Mac OS X 10_15_7',
  'Windows NT 10.0; Win64; x64',
  'X11; Linux x86_64',
])('identity preserves native platform and Chromium version: %s', (platform) => {
  const browser = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7734.0 Safari/537.36`;
  const shell = browser.replace('Chrome/', 'epo/3.1.1 Chrome/').replace('Safari/', 'Electron/44.1.1 Safari/');
  expect(browserUserAgent(shell)).toBe(browser);
  expect(browserUserAgent(browser)).toBe(browser);
  expect(browserUserAgent(browserUserAgent(shell))).toBe(browser);
});

test('unknown native formats fail explicitly instead of guessing a foreign identity', () => {
  expect(() => browserUserAgent('unexpected')).toThrow('native Chromium');
});
