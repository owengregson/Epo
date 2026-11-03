/**
 * The seed check (spec §13): nothing at launch, no hold before an explicit check; a stored profile within one
 * weekly cycle of plan-days answers without a visit; every busy reason queues (the latest handle wins) and the
 * queued check runs once when the tab is free; a visit takes a read permit; only evidence reads as not found.
 */
import { ActionAbortedError } from '@/adapter/errors';
import { type SeedCheckDeps, SeedCheckService, type SeedStoreView } from '@/main/modules/seed-check';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { toLegacySeedCheck } from '@/shared/seed-check';
import type { AccountState } from '@/store/types';
import { setLevel } from '@/utils/logger';

const DAY = 86_400_000;
const NOW = 100 * DAY;
/** Plan-days are whole UTC days here. */
const planDay = { window: (t: number) => ({ key: String(Math.floor(t / DAY)), startsAt: Math.floor(t / DAY) * DAY, endsAt: (Math.floor(t / DAY) + 1) * DAY, quietMinute: 0 }) };

const seen = (over: Partial<AccountState> = {}): AccountState =>
  ({ pk: '42', username: 'friend', enrichment: 'profile', isPrivate: false, followers: 900, statsObservedAt: NOW - DAY, firstSeenAt: 1, lastSeenAt: NOW - DAY, ...over }) as AccountState;

function rig(o: { account?: AccountState | null; busy?: string | null; visit?: ProfileVisit | Error; permit?: boolean; graph?: boolean } = {}) {
  const calls: string[] = [];
  let busy = o.busy ?? null;
  const account = o.account === undefined ? null : o.account;
  const store: Omit<SeedStoreView, 'ownPk'> = {
    pkByUsername: (u) => (account !== null && u === account.username ? account.pk : null),
    getAccount: (pk) => (account !== null && pk === account.pk ? account : null),
    getEdge: () => null,
  };
  const graph = {
    ownPk: '1', store,
    sentinel: { check: async () => 'ok' },
    profiles: {
      visit: async (u: string): Promise<ProfileVisit> => {
        calls.push(`visit ${u}`);
        if (o.visit instanceof Error) throw o.visit;
        return o.visit ?? { ok: true, obs: { accountPk: '42', observedAt: NOW, source: 'profile', fields: { isPrivate: false, followers: 10 } }, viewer: { following: false, requested: false } } as ProfileVisit;
      },
    },
  } as unknown as BuiltGraph;
  const deps: SeedCheckDeps = {
    activity: { with: (name, fn) => { calls.push(`hold ${name}`); return fn(); } },
    trackManualOp: (run) => run(),
    graph: () => (o.graph === false ? null : graph),
    busyDriverReason: () => busy,
    setManualDriving: (on) => calls.push(`manual ${on}`),
    resumeDesiredRun: () => calls.push('resume'),
    changed: () => calls.push('changed'),
    planDay,
    readPermit: o.permit === undefined ? undefined : () => { calls.push('permit'); return { allowed: o.permit === true, resumeAt: null }; },
    now: () => NOW,
  };
  const svc = new SeedCheckService(deps);
  const view = { ownPk: '1', ...store };
  return { svc, calls, view, free: () => { busy = null; }, setBusy: (b: string) => { busy = b; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
beforeAll(() => setLevel('error'));

test('nothing runs at launch: no hold, no visit, no queue until someone asks', () => {
  const { svc, calls, view } = rig({ account: seen() });
  svc.onTabFree();
  expect(calls).toEqual([]);
  expect(svc.status(view, 'friend')).toMatchObject({ kind: 'seen', pk: '42', followers: 900, isPrivate: false, followersVisible: true });
  expect(svc.status(null, 'friend')).toEqual({ kind: 'loading' });
  expect(svc.status(view, '')).toEqual({ kind: 'none' });
  expect(svc.status(view, 'stranger')).toEqual({ kind: 'unseen', handle: 'stranger' });
});

test('a profile the store saw within one weekly cycle of plan-days answers from the store, no visit', async () => {
  const fresh = rig({ account: seen({ statsObservedAt: NOW - 6 * DAY }) });
  expect(await fresh.svc.check('@Friend')).toEqual({ kind: 'ok', pk: '42', isPrivate: false, followersVisible: true, followers: 900, observedAt: NOW - 6 * DAY, fromStore: true });
  expect(fresh.calls).toEqual([]);
  const stale = rig({ account: seen({ statsObservedAt: NOW - 8 * DAY }) });
  expect(await stale.svc.check('friend')).toMatchObject({ kind: 'ok', fromStore: false });
  expect(stale.calls).toEqual(['changed', 'hold seed-check', 'manual true', 'visit friend', 'manual false', 'resume', 'changed']);
});

test.each([
  ['engine-running', 'engine'], ['prune-running', 'prune'], ['manual-running', 'manual'], ['runtime-not-ready', 'runtime-blocked'],
  ['offline', 'offline'], ['starting', 'starting'],
] as const)('a busy tab (%s) queues the check as %s: never a visit, never "not found"', async (busy, why) => {
  const { svc, calls, view } = rig({ busy });
  const r = await svc.check('friend');
  expect(r).toEqual({ kind: 'queued', why });
  expect(toLegacySeedCheck(r).reason).not.toBe('not-found');
  expect(svc.status(view, 'friend')).toEqual({ kind: 'queued', handle: 'friend', why });
  expect(calls).toEqual(['changed']);
});

test('the queued check runs once when the tab is free, and the latest handle wins', async () => {
  const { svc, calls, free, view } = rig({ busy: 'engine-running' });
  await svc.check('first');
  await svc.check('second');
  svc.onTabFree();
  expect(calls.filter((c) => c.startsWith('visit'))).toEqual([]);
  free();
  svc.onTabFree();
  await flush();
  svc.onTabFree();
  await flush();
  expect(calls.filter((c) => c.startsWith('visit'))).toEqual(['visit second']);
  expect(svc.status(view, 'second')).toEqual({ kind: 'unseen', handle: 'second' });
});

test('signed out queues; a spent read budget queues; a permit is taken before every visit', async () => {
  expect(await rig({ graph: false }).svc.check('friend')).toEqual({ kind: 'queued', why: 'signed-out' });
  const spent = rig({ permit: false });
  expect(await spent.svc.check('friend')).toEqual({ kind: 'queued', why: 'read-budget' });
  expect(spent.calls).toEqual(['permit', 'changed']);
  const ok = rig({ permit: true });
  await ok.svc.check('friend');
  expect(ok.calls.slice(0, 3)).toEqual(['permit', 'changed', 'hold seed-check']);
});

test('only evidence reads as not found; every other outcome is unreadable and the field stays unchanged', async () => {
  const absent = rig({ visit: { ok: false, kind: 'gone', evidence: 'profile-absent', detail: {} } });
  expect(await absent.svc.check('friend')).toEqual({ kind: 'not-found', evidence: 'profile-absent', observedAt: NOW });
  expect(absent.svc.status(absent.view, 'friend')).toEqual({ kind: 'gone', handle: 'friend', at: NOW, evidence: 'profile-absent' });
  const cases: [ProfileVisit | Error, string][] = [
    [{ ok: false, kind: 'walled', detail: {} }, 'walled'],
    [{ ok: false, kind: 'unanswered', detail: { drift: 'shape' } }, 'drift'],
    [{ ok: false, kind: 'unanswered', detail: {} }, 'no-answer'],
    [{ ok: false, kind: 'tab', detail: {} }, 'error'],
    [new ActionAbortedError('profile.visit'), 'aborted'],
    [new Error('boom'), 'error'],
  ];
  for (const [visit, why] of cases) expect(await rig({ visit }).svc.check('friend')).toEqual({ kind: 'unreadable', why });
  expect(await rig().svc.check('not a handle!')).toEqual({ kind: 'invalid-handle' });
});

test('the wire keeps its older shape: a private seed is visible only to an account that follows it', async () => {
  const r = await rig({ visit: { ok: true, obs: { accountPk: '42', observedAt: NOW, source: 'profile', fields: { isPrivate: true } }, viewer: { following: false, requested: false } } as ProfileVisit }).svc.check('friend');
  expect(toLegacySeedCheck(r)).toEqual({ ok: true, exists: true, followersVisible: false, isPrivate: true, reason: 'private' });
});
