/**
 * The v2 settings service (spec §6.6, §6.9): construction reads or migrates; every write persists first
 * (a failed write changes nothing: no swap, no listener, no push); one push per success with rev + 1;
 * previews are pure; the transitional v1 window keeps today's readers and rethrows a failed save.
 */
import { SettingsServiceV2 } from '@/main/modules/settings-service';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import type { SettingsView } from '@/shared/settings-view';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';

function service(files: Record<string, string> = {}, knowledgeDbExists = false) {
  const m = memoryFs(files);
  const pushed: SettingsView[] = [];
  const svc = new SettingsServiceV2({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => knowledgeDbExists,
    math: FAKE_PLAN_MATH, now: () => 1_000, push: (v) => pushed.push(v) });
  return { svc, m, pushed };
}

test('a fresh install starts on the recommended document, ready, nothing written', () => {
  const { svc, m } = service();
  expect(svc.view()).toMatchObject({ rev: 0, health: { kind: 'ok' }, protectionState: 'ready', easy: { pace: 'balanced' } });
  expect(m.data.size).toBe(0);
});

test('a v1 file migrates at first launch: zero overrides, notices queued, v2 and its marker written', () => {
  const v1 = JSON.stringify({ ...DEFAULT_SETTINGS, seed: '@friend', pruneBioFilterWords: ['art'] });
  const { svc, m } = service({ [F.v1]: v1 });
  const view = svc.view();
  expect(view.health.kind).toBe('migrated');
  expect(view.overrides.count).toBe(0);
  expect(view.notices.map((n) => n.kind)).toEqual(expect.arrayContaining(['migrated', 'verified-kept', 'bio-words-widened']));
  expect(JSON.parse(m.data.get(F.v2) ?? '{}')).toMatchObject({ v: 2, rev: 1, seed: 'friend' });
  expect(m.data.has(F.created)).toBe(true);
  expect(m.data.get(F.v1)).toBe(v1);
});

test('a forced write failure is not-saved: no swap, no reload, no push, nothing applied', () => {
  const { svc, m, pushed } = service();
  const heard: number[] = [];
  svc.onChange((e) => heard.push(e.rev));
  m.failOn('rename');
  const r = svc.apply([{ op: 'intent', key: 'activity', value: 'active' }], 'user');
  expect(r.kind).toBe('not-saved');
  expect([svc.view().intent.activity, svc.view().rev, heard, pushed]).toEqual(['moderate', 0, [], []]);
});

test('one push per saved change, each a revision later; the listener hears what moved', () => {
  const { svc, pushed } = service();
  const heard: { rev: number; volume: number }[] = [];
  svc.onChange((e) => heard.push({ rev: e.rev, volume: e.next.dailyOperatingRate }));
  svc.apply([{ op: 'intent', key: 'activity', value: 'active' }], 'user');
  svc.apply([{ op: 'pref', key: 'practice', value: true }], 'user');
  expect(pushed.map((v) => v.rev)).toEqual([1, 2]);
  expect(heard).toEqual([{ rev: 1, volume: 75 }, { rev: 2, volume: 75 }]);
});

test('a saved result carries its undo, its conflicts and when it applies', () => {
  const { svc } = service();
  svc.apply([{ op: 'override', key: 'pace.dailyCeiling', value: 60 }], 'user');
  const r = svc.apply([{ op: 'intent', key: 'activity', value: 'active' }], 'user');
  expect(r.kind === 'saved' && r.inverse).toEqual([{ op: 'intent', key: 'activity', value: 'moderate' }]);
  expect(r.kind === 'saved' && r.conflicts.map((c) => [c.key, c.recommendedBefore, c.recommendedNow])).toEqual([['pace.dailyCeiling', 65, 98]]);
  expect(r.kind === 'saved' && r.applies.map((a) => a.what)).toEqual(['applies-now', 'from-tomorrow']);
});

test('a preview is pure: nothing written, nothing pushed, and it flags what unfollows more', () => {
  const { svc, m, pushed } = service();
  const r = svc.preview([{ op: 'intent', key: 'patience', value: 'quick' }]);
  expect(r.kind === 'ok' && r.changes.find((c) => c.key === 'unfollow.waitDays')).toMatchObject({ before: 4, after: 2, loosensUnfollows: true });
  expect([m.data.size, pushed.length, svc.view().intent.patience]).toEqual([0, 0, 'normal']);
});

test('protection compiles from the v2 document, per revision', () => {
  const { svc } = service();
  svc.apply([{ op: 'protect-add', entries: [{ username: 'anna' }], source: 'you' }], 'user');
  expect(svc.protection()).toBe(svc.protection());
  expect(svc.resolveSettings().pruneWhitelist).toEqual(['anna']);
});

test('the transitional window: a v1 partial becomes keyed ops; a failed save rethrows; stamps persist', async () => {
  const { svc, m } = service();
  await svc.updateSettings({ pruneWhitelist: ['anna', 'bob'], dailyOperatingRate: 60 });
  expect(svc.view().protection.accounts.map((a) => a.username)).toEqual(['anna', 'bob']);
  expect(svc.view().overrides.count).toBe(1);
  await svc.updateSettings({ sweepLastRunAt: 777 });
  expect(svc.resolveSettings().sweepLastRunAt).toBe(777);
  m.failOn('rename');
  await expect(svc.updateSettings({ seed: 'x' })).rejects.toThrow('not saved');
});

test('a system-only op from the user is refused with a view', () => {
  const { svc } = service();
  expect(svc.apply([{ op: 'consume-bookkeeping' }], 'user')).toMatchObject({ kind: 'refused', reason: 'invalid', view: { rev: 0 } });
});
