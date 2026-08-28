import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Regression: organic-pacing-unreachable. The adaptive pacing model
 * (`pacingModel: 'organic'`) is the DEFAULT and must actually reach the engine:
 * a Foundation built with default settings injects the SessionPlanner, which
 * surfaces as a non-null `pacing` projection on the engine status. An install
 * that explicitly stored 'legacy' keeps the metronome (pacing stays null).
 * Before this, the default + sanitizer both forced 'legacy', so the whole
 * session/circadian layer — and every Behavior-card knob feeding it — was
 * unreachable dead code.
 *
 * Electron is mocked at module scope exactly as in foundation-teardown.test.ts:
 * `app.getPath` → a temp dir, and the IG partition serves a fixed `ds_user_id`.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-pacing-'));

jest.mock('electron', () => ({
  app: { getPath: () => tmp },
  session: {
    fromPartition: () => ({
      cookies: { get: async () => [{ name: 'ds_user_id', value: '4242' }] },
      clearStorageData: async () => {},
      clearCache: async () => {},
    }),
  },
}));

import type { InstagramTab } from '@/adapter/tab';
import { Foundation } from '@/main/foundation-wiring';
import { setLevel } from '@/utils/logger';

beforeAll(() => setLevel('error'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const fakeTab = {
  show: () => {},
  hide: () => {},
  goto: async () => {},
  currentUrl: () => 'https://www.instagram.com/',
  evaluate: async () => '/myself/',
  onResponse: () => () => {},
} as unknown as InstagramTab;

test('default settings build the engine WITH the session planner (organic reachable + default)', async () => {
  const f = new Foundation({ tab: fakeTab });
  // No settings file exists yet in this userData dir → pure defaults.
  expect((await f.getSettings()).pacingModel).toBe('organic');

  expect(await f.ensureBuilt()).toBe(true);
  const s = await f.status();
  // The planner projection exists only when the SessionPlanner dep was injected.
  expect(s.pacing).not.toBeNull();
  expect(typeof s.pacing?.dailyTarget).toBe('number');
  expect(typeof s.pacing?.sessionOpen).toBe('boolean');

  await f.dispose();
});

test('an explicit stored legacy model keeps the metronome (no planner injected)', async () => {
  const f = new Foundation({ tab: fakeTab });
  // Persisted BEFORE the build — the graph is constructed from the stored choice.
  await f.updateSettings({ pacingModel: 'legacy' });

  expect(await f.ensureBuilt()).toBe(true);
  const s = await f.status();
  expect(s.pacing).toBeNull();

  // The stored value survives a reload untouched (the sanitizer respects 'legacy').
  expect((await f.getSettings()).pacingModel).toBe('legacy');

  await f.dispose();
});
