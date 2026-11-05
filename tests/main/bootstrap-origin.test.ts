jest.mock('electron', () => ({}));
jest.mock('@/adapter/tab', () => ({ IG_HOME_URL: 'https://www.instagram.com/' }));
jest.mock('@/timing/primitives', () => ({ sleep: jest.fn(async () => {}) }));

import { IG_HOME_URL, type InstagramTab } from '@/adapter/tab';
import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';
import { ensureInstagramOrigin } from '@/main/bootstrap';
import { sleep } from '@/timing/primitives';

beforeEach(() => jest.clearAllMocks());

test.each([
  'https://unrelated.example/?next=instagram.com',
  'https://instagram.com.attacker.example/',
  'https://instagram.com@attacker.example/',
  'http://www.instagram.com/',
  'https://www.instagram.com:8443/',
  'about:blank',
])('repairs a noncanonical origin before page reads: %s', async (url) => {
  const goto = jest.fn(async () => {});
  await ensureInstagramOrigin({ currentUrl: () => url, goto } as unknown as InstagramTab);
  expect(goto).toHaveBeenCalledWith(IG_HOME_URL);
  expect(sleep).toHaveBeenCalledWith(RUNTIME_BOUNDS.ORIGIN_SETTLE_MS);
  expect(goto.mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(sleep).mock.invocationCallOrder[0]);
});

test('a canonical profile stays in place without navigation or settling', async () => {
  const goto = jest.fn(async () => {});
  await ensureInstagramOrigin({ currentUrl: () => `${IG_HOME_URL}example/`, goto } as unknown as InstagramTab);
  expect(goto).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});
