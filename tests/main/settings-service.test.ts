/**
 * The v2 settings service (spec §6.6, §6.9): construction reads or migrates; every write persists first
 * (a failed write changes nothing: no swap, no listener, no push); one push per success with rev + 1;
 * previews are pure; the transitional v1 window keeps today's readers and rethrows a failed save.
 */
import type { PlanPreviewPort } from '@/governors/plan-types';
import type { PlanIntent } from '@/kernel/plan/types';
import { SettingsService } from '@/main/modules/settings-service';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { toPlanIntent } from '@/settings/plan-intent';
import { DEFAULT_SETTINGS } from '@/settings/v1/settings-v1';
import type { SettingsView } from '@/shared/settings-view';
import { protectionVerdict } from '@/shared/unfollow-protection';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';

function service(files: Record<string, string> = {}, knowledgeDbExists = false) {
  const m = memoryFs(files);
  const pushed: SettingsView[] = [];
  const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => knowledgeDbExists,
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
  expect(svc.view().protection.accounts.map((a) => a.username)).toEqual(['anna']);
});


test('a system-only op from the user is refused with a view', () => {
  const { svc } = service();
  expect(svc.apply([{ op: 'consume-bookkeeping' }], 'user')).toMatchObject({ kind: 'refused', reason: 'invalid', view: { rev: 0 } });
});

test('protection compiles with the new predicate: a bio word protects everyone, not only follow-backs', () => {
  const { svc } = service();
  svc.apply([{ op: 'word-add', texts: ['Café'] }], 'user');
  expect(protectionVerdict({ pk: '7', username: 'stranger', bio: 'CAFE owner', isVerified: false }, svc.protection()))
    .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
});

test('capabilities start off; the preview port fills the week only with the plan capability, and can be withdrawn', () => {
  const { svc } = service();
  expect(svc.view().capabilities).toEqual({ plan: false, tempo: false, boost: false, protectionEverywhere: false });
  const asked: [PlanIntent, number, number][] = [];
  const port: PlanPreviewPort = { previewDays: (i, at, n) => { asked.push([i, at, n]); return []; } };
  svc.setPlanPort(port);
  expect([svc.planPort(), svc.view().typical.week]).toEqual([port, null]);
  svc.setCapabilities({ plan: true });
  expect(svc.view().typical.week).toEqual([]);
  expect(asked).toEqual([[toPlanIntent(svc.effective()), 1_000, 7]]);
  svc.setPlanPort(null);
  expect([svc.planPort(), svc.view().typical.week]).toEqual([null, null]);
});

test('with the port, the save note says re-planned exactly when the plan intent moved', () => {
  const { svc } = service();
  svc.setPlanPort({ previewDays: () => [] });
  svc.setCapabilities({ plan: true });
  const shape = svc.apply([{ op: 'intent', key: 'dayShape', value: 'evening' }], 'user');
  expect(shape.kind === 'saved' && shape.applies.map((a) => a.what)).toEqual(['replanned-today']);
  const seed = svc.apply([{ op: 'seed', handle: 'friend' }], 'user');
  expect(seed.kind === 'saved' && seed.applies).toEqual([]);
});


test('migration bookkeeping remains readable until the reopen state consumes it once', () => {
  const raw = JSON.stringify({ ...DEFAULT_SETTINGS, sweepLastRunAt: 5, pruneLastRunAt: 9 });
  const { svc, m } = service({ [F.v1]: raw });
  expect(svc.takeBookkeeping('me')).toMatchObject({ forPk: 'me', sweepLastRunAt: 5, pruneLastRunAt: 9 });
  expect(svc.apply([{ op: 'consume-bookkeeping' }], 'system').kind).toBe('saved');
  expect(svc.takeBookkeeping('me')).toBeNull();
  expect(JSON.parse(m.data.get(F.v2) ?? '{}').migration.bookkeeping).toBeNull();
  expect(m.data.get(F.v1)).toBe(raw);
});

test('lists an older build added after the migration are offered back union-only: add them, or ignore them', () => {
  const v1 = (accounts: string[], words: string[]) =>
    JSON.stringify({ ...DEFAULT_SETTINGS, pruneWhitelist: accounts, pruneBioFilterWords: words });
  const files = Object.fromEntries(service({ [F.v1]: v1(['alice', 'bob'], ['art']) }).m.data);
  files[F.v1] = v1(['alice', 'carol', 'dave'], ['art', 'travel']);
  const relaunch = () => {
    const m = memoryFs(files, 2);
    return { m, svc: new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => true, math: FAKE_PLAN_MATH,
      now: () => 2_000, push: () => {} }) };
  };
  const { svc, m } = relaunch();
  const notice = svc.view().notices.find((n) => n.kind === 'older-version-changed');
  expect(notice).toMatchObject({ tone: 'info', data: { accounts: 2, words: 1 }, dismissible: true });
  expect(svc.apply([{ op: 'import-older-version' }], 'user')).toMatchObject({ kind: 'saved', view: { rev: 2 } });
  const saved = JSON.parse(m.data.get(F.v2) ?? '{}');
  expect(saved.protection.accounts.map((a: { username: string }) => a.username)).toEqual(['alice', 'bob', 'carol', 'dave']);
  expect(saved.protection.words.map((w: { text: string }) => w.text)).toEqual(['art', 'travel']);
  expect(svc.view().notices.some((n) => n.kind === 'older-version-changed')).toBe(false);
  expect(svc.apply([{ op: 'import-older-version' }], 'user')).toMatchObject({ kind: 'refused', reason: 'invalid' });

  const ignored = relaunch().svc;
  expect(ignored.apply([{ op: 'dismiss-notice', id: notice?.id ?? '' }], 'user')).toMatchObject({ kind: 'saved' });
  expect(ignored.view().notices.some((n) => n.kind === 'older-version-changed')).toBe(false);
});

describe('the effective settings are upstream of the plan; the week preview is downstream', () => {
  // The port reads the settings back, as the plan's demand and intent do in plan-wiring.
  function planBacked() {
    const { svc } = service();
    let draws = 0;
    svc.setPlanPort({ previewDays: () => {
      draws += 1;
      svc.effective();
      svc.protection();
      return [];
    } });
    svc.setCapabilities({ plan: true });
    draws = 0;
    return { svc, draws: () => draws };
  }

  test('a port that reads the settings back: view() returns and the week is drawn once per revision', () => {
    const { svc, draws } = planBacked();
    expect([svc.view().typical.week, svc.view().typical.week, draws()]).toEqual([[], [], 0]);
    svc.apply([{ op: 'intent', key: 'activity', value: 'active' }], 'user');
    expect([svc.view().rev, svc.view().typical.week, draws()]).toEqual([1, [], 1]);
  });

  test('effective(), protection() and the change events never draw the week', () => {
    const { svc, draws } = planBacked();
    const heard: number[][] = [];
    svc.onChange((e) => heard.push([e.next.dailyOperatingRate, draws()]));
    expect([svc.effective().dailyOperatingRate, svc.protection().rev, draws()]).toEqual([50, 0, 0]);
    svc.setCapabilities({ plan: false });
    svc.setCapabilities({ plan: true });
    expect([svc.effective().dailyOperatingRate, draws()]).toEqual([50, 1]);
    // The port stays registered: the listener hears the new settings undrawn; only the pushed view draws, once.
    svc.apply([{ op: 'intent', key: 'activity', value: 'active' }], 'user');
    expect([heard, svc.effective().dailyOperatingRate, svc.protection().rev, draws()]).toEqual([[[75, 1]], 75, 1, 2]);
  });
});


test('capability changes push the current derived view at the same document revision', () => {
  const { svc, pushed } = service();
  svc.setPlanPort({ previewDays: () => [] });
  svc.setCapabilities({ plan: true, tempo: true, boost: true });
  expect(pushed).toHaveLength(1);
  expect(pushed[0]).toMatchObject({ rev: 0, capabilities: { plan: true, tempo: true, boost: true } });
  svc.setCapabilities({ plan: true });
  expect(pushed).toHaveLength(1);
  svc.setPlanPort(null);
  svc.setCapabilities({ plan: false, tempo: false, boost: false });
  expect(pushed).toHaveLength(2);
  expect(pushed[1]).toMatchObject({ rev: 0, capabilities: { plan: false, tempo: false, boost: false } });
});


test('migration retains a custom lower cleanup cap when the new plan ceiling is higher', () => {
  const { svc } = service({ [F.v1]: JSON.stringify({ ...DEFAULT_SETTINGS, pruneDailyLimit: 40 }) });
  expect(svc.effective().dailyHardCeiling).toBe(65);
  expect(svc.effective().cleanupPerDayOverride).toBe(40);
  svc.setCapabilities({ plan: true });
  expect(svc.effective().cleanupPerDayOverride).toBe(40);
});
