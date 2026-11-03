/**
 * The protection linker (spec §7.7): links the handles the store maps and follows renames, as system ops,
 * only on change — at open, then once per burst of store writes; zero Instagram traffic; unbinding stops it.
 */
import { linkOps, type SettingsStoreBinding } from '@/main/modules/protection-linker';
import { SettingsService } from '@/main/modules/settings-service';
import type { ProtectedAccount } from '@/shared/settings-model';
import { POLL } from '@/timing/config';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';

const entry = (over: Partial<ProtectedAccount>): ProtectedAccount =>
  ({ pk: null, username: 'anna', linkedAt: null, formerUsernames: [], addedAt: 1, source: 'you', valid: true, ...over }) as ProtectedAccount;

function storeOf(names: Record<string, string>) {
  const listeners = new Set<() => void>();
  const binding: SettingsStoreBinding = {
    ownPk: '1',
    pkByUsername: (u) => Object.keys(names).find((pk) => names[pk] === u) ?? null,
    username: (pk) => names[pk] ?? null,
    onMutation: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return { binding, names, write: () => { for (const fn of listeners) fn(); }, listeners };
}

test('the links a store implies: mapped handles, renames, nothing when current, all-digit entries left as v1 had them', () => {
  const { binding } = storeOf({ 11: 'anna', 12: 'bob.new', 13: 'carl' });
  expect(linkOps([
    entry({ username: 'anna' }),
    entry({ username: 'zed' }),
    entry({ pk: '12', username: 'bob', linkedAt: 5 }),
    entry({ pk: '13', username: 'carl', linkedAt: 5 }),
    entry({ pk: '13', username: 'carl', linkedAt: null }),
    entry({ pk: '999', username: '999' }),
    entry({ username: 'bad name', valid: false }),
  ], binding, 7)).toEqual([
    { op: 'protect-link', pk: '11', username: 'anna', at: 7 },
    { op: 'protect-link', pk: '12', username: 'bob.new', at: 7 },
    { op: 'protect-link', pk: '13', username: 'carl', at: 7 },
  ]);
});

describe('through the settings service', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function rig() {
    const m = memoryFs();
    let now = 100;
    const svc = new SettingsService({ userDataDir: '/u', fs: m.fs, knowledgeDbExists: () => false, math: FAKE_PLAN_MATH,
      now: () => now, push: () => {} });
    svc.apply([{ op: 'protect-add', entries: [{ username: 'anna' }], source: 'you' }], 'user');
    return { svc, m, tick: (ms: number) => { now += ms; jest.advanceTimersByTime(ms); } };
  }

  test('binding links at once, a rename follows after the burst, and an unchanged store writes nothing', () => {
    const { svc, m, tick } = rig();
    const s = storeOf({ 11: 'anna' });
    svc.bindStore(s.binding);
    expect(svc.view().protection.accounts).toMatchObject([{ pk: '11', username: 'anna', linkedAt: 100 }]);
    const revAfterLink = svc.view().rev;
    s.write();
    s.write();
    tick(POLL.GRAPH_PUSH_THROTTLE_MS);
    expect(svc.view().rev).toBe(revAfterLink);
    s.names[11] = 'anna.b';
    s.write();
    s.write();
    tick(POLL.GRAPH_PUSH_THROTTLE_MS);
    expect(svc.view().protection.accounts).toMatchObject([{ pk: '11', username: 'anna.b', formerUsernames: ['anna'] }]);
    expect(svc.view().rev).toBe(revAfterLink + 1);
    expect(JSON.parse(m.data.get('epo-settings-v2.json') ?? '{}').protection.accounts[0]).toMatchObject({ pk: '11', username: 'anna.b' });
  });

  test('unbinding stops following the store', () => {
    const { svc, tick } = rig();
    const s = storeOf({});
    svc.bindStore(s.binding);
    svc.bindStore(null);
    expect(s.listeners.size).toBe(0);
    s.names[11] = 'anna';
    s.write();
    tick(POLL.GRAPH_PUSH_THROTTLE_MS);
    expect(svc.view().protection.accounts).toMatchObject([{ pk: null, username: 'anna' }]);
  });
});
