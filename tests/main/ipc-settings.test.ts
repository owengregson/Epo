/**
 * The Settings rows through the real registration (Appendix B.9): the guard refuses a malformed op before
 * the service sees it, a throwing handler answers its typed fallback, and neither ever reads as saved.
 * The rows still waiting for their stores answer typed values; `seed:check` keeps its older wire shape.
 */
import type { IpcFallbacks, IpcHandlers } from '@/ipc/register';
import { registerIpc } from '@/ipc/register';
import type { Foundation } from '@/main/foundation-wiring';
import { settingsFallbacks, settingsHandlers } from '@/main/ipc-settings';
import { SettingsService } from '@/main/modules/settings-service';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { setLevel } from '@/utils/logger';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';

const registered = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => Promise<unknown>) => registered.set(channel, fn),
    removeHandler: (channel: string) => registered.delete(channel),
  },
}));

const SEED_OK = { ok: true, exists: true, followersVisible: true, isPrivate: false };

function rig() {
  const m = memoryFs();
  const settings = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => false, math: FAKE_PLAN_MATH,
    now: () => 1_000, push: () => {} });
  const seed = { check: async () => ({ kind: 'ok', pk: '1', isPrivate: false, followersVisible: true, followers: null, observedAt: 1, fromStore: true }) };
  const foundation = { settings, seed } as unknown as Foundation;
  // Every other row is someone else's: a placeholder keeps registerIpc total.
  const total = <T extends object>(rows: Partial<T>): T =>
    new Proxy(rows, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => null) }) as T;
  const dispose = registerIpc(total<IpcHandlers>(settingsHandlers(foundation)), total<IpcFallbacks>(settingsFallbacks(foundation)));
  const call = (channel: string, ...args: unknown[]) => {
    const fn = registered.get(channel);
    if (fn === undefined) throw new Error(`${channel} is not registered`);
    return fn({}, ...args);
  };
  return { m, settings, call, dispose };
}

beforeAll(() => setLevel('error'));

test('a malformed op is refused at the guard with the typed fallback: nothing applied, nothing written', async () => {
  const { m, settings, call, dispose } = rig();
  for (const bad of [[], [{ op: 'override', key: 'pace.nope', value: 1 }], [{ op: 'intent', key: 'activity', value: 'turbo' }], 'x']) {
    expect(await call('settings:apply', bad)).toMatchObject({ kind: 'refused', reason: 'internal', view: { rev: 0 } });
    expect(await call('settings:preview', bad)).toEqual({ kind: 'unavailable' });
  }
  expect([settings.view().rev, m.data.size]).toEqual([0, 0]);
  dispose();
});

test('a handler that throws answers refused, never saved', async () => {
  const { settings, call, dispose } = rig();
  jest.spyOn(settings, 'apply').mockImplementation(() => { throw new Error('boom'); });
  expect(await call('settings:apply', [{ op: 'pref', key: 'practice', value: true }])).toMatchObject({ kind: 'refused', reason: 'internal' });
  dispose();
});

test('a valid op saves through the service; a failed write is not-saved and changes nothing', async () => {
  const { m, settings, call, dispose } = rig();
  expect(await call('settings:apply', [{ op: 'intent', key: 'activity', value: 'active' }])).toMatchObject({ kind: 'saved', view: { rev: 1 } });
  expect(JSON.parse(m.data.get(F.v2) ?? '{}')).toMatchObject({ rev: 1, intent: { activity: 'active' } });
  m.failOn('rename');
  expect(await call('settings:apply', [{ op: 'intent', key: 'activity', value: 'light' }])).toMatchObject({ kind: 'not-saved' });
  expect([settings.view().rev, settings.view().intent.activity]).toEqual([1, 'active']);
  expect(await call('settings:preview', [{ op: 'intent', key: 'patience', value: 'quick' }])).toMatchObject({ kind: 'ok' });
  dispose();
});

test('the transitional v1 rows: a failed save rejects so the old UI says Not saved', async () => {
  const { m, call, dispose } = rig();
  expect(await call('settings:update', { dryRun: true })).toMatchObject({ dryRun: true });
  m.failOn('rename');
  await expect(call('settings:update', { dryRun: false })).rejects.toThrow('not saved');
  await expect(call('settings:reset')).rejects.toThrow('not reset');
  dispose();
});

test('the rows still waiting for their stores answer typed values, and the seed check keeps its older shape', async () => {
  const { call, dispose } = rig();
  expect(await call('settings:view')).toMatchObject({ rev: 0, health: { kind: 'ok' } });
  expect(await call('settings:basis')).toEqual({ kind: 'unavailable' });
  expect(await call('settings:facts')).toMatchObject({ built: false, protection: null });
  expect(await call('accounts:suggest', 'ja', 'following')).toEqual({ kind: 'unavailable' });
  expect(await call('protection:kept', 0)).toEqual({ kind: 'unavailable' });
  expect(await call('seed:check', 'natgeo')).toEqual(SEED_OK);
  dispose();
});
