/**
 * The new IPC rows answer typed values from their first commit (spec §15.1):
 * stubs return their typed fallbacks, or today's behaviour where one exists,
 * and every row has a handler and a fallback.
 */

import { CHANNELS } from '@/ipc/contract';
import type { Foundation } from '@/main/foundation-wiring';
import { bootFallbacks, bootHandlers } from '@/main/ipc-boot';
import { liveFallbacks, liveHandlers } from '@/main/ipc-live';
import { BOOST_OFF, planFallbacks, planHandlers } from '@/main/ipc-plan';
import { settingsFallbacks, settingsHandlers } from '@/main/ipc-settings';
import { isStageMode, STAGE_MODES } from '@/shared/stage-mode';

const VIEW = { rev: 3 };
const SEED_OK = { ok: true, exists: true, followersVisible: true, isPrivate: false };
const foundation = {
  settings: { view: () => VIEW },
  checkSeed: async () => SEED_OK,
  getSettings: async () => ({ seed: 's' }),
} as unknown as Foundation;
const UPDATE = { state: 'unchecked', mode: 'off', current: '3.1.1', version: null, percent: null, error: null } as const;

test('the settings rows: the transitional view, typed refusals, today\'s seed shape', async () => {
  const h = settingsHandlers(foundation);
  expect(await h.settingsView()).toBe(VIEW);
  expect(await h.applySettings([{ op: 'ui', mode: 'advanced' }])).toMatchObject({ kind: 'refused', reason: 'internal', view: VIEW });
  expect(await h.previewSettings([{ op: 'ui', mode: 'easy' }])).toEqual({ kind: 'unavailable' });
  expect(await h.settingsBasis()).toEqual({ kind: 'unavailable' });
  expect(await h.settingsFacts()).toMatchObject({ built: false, seed: { kind: 'loading' }, protection: null });
  expect(await h.suggestAccounts('ja', 'following')).toEqual({ kind: 'unavailable' });
  expect(await h.keptList(0)).toEqual({ kind: 'unavailable' });
  expect(await h.checkSeed('natgeo')).toEqual(SEED_OK);
  expect(await settingsFallbacks(foundation).checkSeed()).toEqual({
    ok: false, exists: false, followersVisible: false, isPrivate: false, reason: 'error',
  });
});

test('the Boost, live and boot rows', async () => {
  expect(await planHandlers().startBoost(12, { alsoStart: false })).toEqual({ kind: 'refused', reason: 'internal', boost: BOOST_OFF });
  expect(await planHandlers().previewBoost(12)).toBeNull();
  const live = liveHandlers(() => UPDATE);
  expect(await live.feedView()).toMatchObject({ items: [], awayFrom: null });
  expect(await live.logTail()).toEqual([]);
  expect(await live.updateStatus()).toBe(UPDATE);
  expect(await bootHandlers().bootRevealed()).toBeUndefined();
  expect(await planFallbacks().endBoost()).toMatchObject({ kind: 'refused' });
  expect(await liveFallbacks(() => UPDATE).updateStatus()).toBe(UPDATE);
  expect(await bootFallbacks().bootRevealed()).toBeUndefined();
});

test('the stage vocabulary is closed and the tab-visibility rows are gone', () => {
  expect(STAGE_MODES).toEqual(['tab', 'people', 'graph', 'prune', 'settings']);
  expect(STAGE_MODES.every(isStageMode)).toBe(true);
  expect(isStageMode('overview')).toBe(false);
  expect(isStageMode(1)).toBe(false);
  expect(CHANNELS).not.toHaveProperty('showTab');
  expect(CHANNELS).not.toHaveProperty('hideTab');
  expect(CHANNELS).toMatchObject({ settingsView: 'settings:view', startBoost: 'boost:start', feedView: 'feed:get',
    bootRevealed: 'boot:revealed' });
});
