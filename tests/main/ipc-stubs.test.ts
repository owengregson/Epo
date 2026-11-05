/**
 * The new IPC rows answer typed values from their first commit (spec §15.1):
 * stubs return their typed fallbacks, or today's behaviour where one exists,
 * and every row has a handler and a fallback.
 */

import { CHANNELS, PUSH } from '@/ipc/contract';
import { bootFallbacks, bootHandlers } from '@/main/ipc-boot';
import { liveFallbacks, liveHandlers } from '@/main/ipc-live';
import { BOOST_OFF, planFallbacks, planHandlers } from '@/main/ipc-plan';
import { surfaceFallbacks, surfaceHandlers } from '@/main/ipc-surface';
import { isStageMode, STAGE_MODES } from '@/shared/stage-mode';
import { SURFACE_AREAS, SURFACE_METERS } from '@/shared/surface-health';

// The settings rows run on the settings service now: tests/main/ipc-settings.test.ts covers them.
const UPDATE = {
  state: 'unchecked', mode: 'off', current: '3.1.1', version: null, percent: null, error: null, checkedAt: null,
} as const;

test('the Boost, live and boot rows', async () => {
  expect(await planHandlers().startBoost(12, { alsoStart: false })).toEqual({ kind: 'refused', reason: 'internal', boost: BOOST_OFF });
  expect(await planHandlers().previewBoost(12)).toBeNull();
  const live = liveHandlers(() => UPDATE);
  expect(await live.feedView()).toMatchObject({ items: [], awayFrom: null });
  expect(await live.logTail()).toEqual([]);
  expect(await live.updateStatus()).toBe(UPDATE);
  expect(await live.activityNow()).toEqual({ activity: null, busy: false, holds: [] });
  expect(await liveFallbacks(() => UPDATE).activityNow()).toEqual({ activity: null, busy: false, holds: [] });
  const revealed = jest.fn();
  expect(await bootHandlers({ bootRevealed: revealed }).bootRevealed()).toBeUndefined();
  expect(revealed).toHaveBeenCalledTimes(1);
  expect(await planFallbacks().endBoost()).toMatchObject({ kind: 'refused' });
  expect(await liveFallbacks(() => UPDATE).updateStatus()).toBe(UPDATE);
  expect(await bootFallbacks().bootRevealed()).toBeUndefined();
});

test('the surface row: the not-built report, every area unseen and nothing recorded', async () => {
  for (const report of [await surfaceHandlers().surfaceReport(), await surfaceFallbacks().surfaceReport()]) {
    expect(report.areas.map((a) => [a.area, a.state, a.lastReadAt])).toEqual(SURFACE_AREAS.map((a) => [a, 'unseen', null]));
    expect(report.areas.every((a) => a.paused.length === 0 && Object.values(a.today).every((n) => n === 0))).toBe(true);
    expect(report).toMatchObject({ surfaceId: '', changes: [], copyText: '' });
    expect(report.meter).toEqual(Object.fromEntries(SURFACE_METERS.map((m) => [m, { n: 0, p50: null, p95: null }])));
  }
  expect(CHANNELS).toMatchObject({ surfaceReport: 'surface:report' });
});

test('the stage vocabulary is closed and the tab-visibility rows are gone', () => {
  expect(STAGE_MODES).toEqual(['tab', 'people', 'graph', 'prune', 'settings']);
  expect(STAGE_MODES.every(isStageMode)).toBe(true);
  expect(isStageMode('overview')).toBe(false);
  expect(isStageMode(1)).toBe(false);
  expect(CHANNELS).not.toHaveProperty('showTab');
  expect(CHANNELS).not.toHaveProperty('hideTab');
  expect(CHANNELS).toMatchObject({ settingsView: 'settings:view', startBoost: 'boost:start', feedView: 'feed:get',
    bootRevealed: 'boot:revealed', activityNow: 'activity:now' });
  expect(PUSH).toMatchObject({ activity: 'epo:activity' });
});
