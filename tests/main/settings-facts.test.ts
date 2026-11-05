/**
 * The settings facts over a real store (spec §6.9, Appendix B.6): honest-unknown before the store opens
 * (nulls, never zeros); counts with the one predicate (per rule, per folded word, unread bios); each protected
 * entry's standing; suggestions by prefix with a limit (wildcards escaped); the kept page and its counts.
 */
import { SeedCheckService } from '@/main/modules/seed-check';
import { settingsFactsSource } from '@/main/modules/settings-facts';
import { SettingsService } from '@/main/modules/settings-service';
import type { BuiltGraph } from '@/main/services/graph-types';
import type { AccountFields, FollowRecord } from '@/store/types';
import { FAKE_PLAN_MATH, memoryFs } from '../kit/settings';
import { memoryStore } from '../kit/store';

const OWN = '1';

function rig() {
  const store = memoryStore();
  const graph = { ownPk: OWN, store } as unknown as BuiltGraph;
  const person = (pk: string, fields: AccountFields, follow: boolean, back: boolean | null = null) => {
    store.observe({ accountPk: pk, observedAt: 10, source: 'profile', fields });
    if (follow) store.observeEdge(OWN, pk, 'follows', true, 10);
    if (back !== null) store.observeEdge(pk, OWN, 'follows', back, 10);
  };
  person(OWN, { username: 'me', isPrivate: true }, false);
  person('11', { username: 'anna', bio: 'Painter', isVerified: false }, true, true);
  person('12', { username: 'a_b', bio: 'CAFÉ owner', isVerified: false }, true, false);
  person('13', { username: 'ab', isVerified: true }, true);
  person('14', { username: 'bob', bio: 'runner', isVerified: false }, false);
  const settings = new SettingsService({ userDataDir: '/u', fs: memoryFs().fs, knowledgeDbExists: () => false, math: FAKE_PLAN_MATH,
    now: () => 20, push: () => {} });
  settings.apply([
    { op: 'protect-add', entries: [{ username: 'anna' }, { username: 'bob' }, { username: 'zed' }], source: 'you' },
    { op: 'word-add', texts: ['Cafe', 'runner'] },
  ], 'user');
  const seed = new SeedCheckService({ activity: { with: (_n, fn) => fn() }, trackManualOp: (run) => run(), graph: () => graph,
    busyDriverReason: () => null, setManualDriving: () => {}, resumeDesiredRun: () => {} });
  let open = true;
  const source = settingsFactsSource(() => (open ? graph : null), () => settings, () => seed);
  return { store, settings, source, close: () => { open = false; } };
}

test('before the store opens every field is honest-unknown, never a zero', () => {
  const { source, close } = rig();
  close();
  expect(source.facts()).toEqual({ built: false, seed: { kind: 'none' }, ownAccount: { isPrivate: null }, protection: null, cleanup: null });
  expect(source.suggest('an', 'known')).toEqual({ kind: 'unavailable' });
  expect(source.kept(0)).toEqual({ kind: 'unavailable' });
});

test('the protection counts read the followed accounts with the one predicate', () => {
  const f = rig().source.facts();
  expect(f).toMatchObject({ built: true, ownAccount: { isPrivate: true }, cleanup: { census: null } });
  expect(f.protection).toMatchObject({
    followingKnown: 3, protectedFollowing: 3, byRule: { account: 1, verified: 1, bioWord: 1 },
    byWord: { cafe: 1, runner: 0 }, bioUnread: 1, kept: { total: 0, unreadable: 0 },
  });
  expect(f.protection?.entries).toEqual({
    anna: { status: 'linked', currentUsername: 'anna', youFollow: true, followsYou: true },
    bob: { status: 'not-followed', currentUsername: 'bob', youFollow: false, followsYou: null },
    zed: { status: 'not-seen', currentUsername: null, youFollow: null, followsYou: null },
  });
});

test('suggestions match a prefix (wildcards escaped), followed first, limited, marked when protected', () => {
  const { source } = rig();
  const known = source.suggest('@A', 'known');
  expect(known.kind === 'ok' && known.rows.map((r) => [r.username, r.youFollow, r.protected])).toEqual([
    ['a_b', true, true], ['ab', true, true], ['anna', true, true],
  ]);
  const escaped = source.suggest('a_', 'known');
  expect(escaped.kind === 'ok' && escaped.rows.map((r) => r.username)).toEqual(['a_b']);
  const following = source.suggest('b', 'following');
  expect(following).toEqual({ kind: 'ok', rows: [] });
  expect(source.suggest('', 'known')).toEqual({ kind: 'ok', rows: [] });
});

test('the kept page lists kept records newest first with the unreadable count', () => {
  const { store, source } = rig();
  const kept = (pk: string, keptReason: FollowRecord['keptReason'], keptAt: number) =>
    store.upsertFollowRecord({ accountPk: pk, state: 'kept', retryCount: 0, keptReason, keptAt, keptMatch: 'cafe' } as FollowRecord);
  kept('12', 'bio-word', 30);
  kept('13', 'unreadable-bio', 40);
  expect(source.kept(0)).toEqual({ kind: 'ok', total: 2, rows: [
    { pk: '13', username: 'ab', reason: 'unreadable-bio', match: 'cafe', keptAt: 40, recheckAt: null },
    { pk: '12', username: 'a_b', reason: 'bio-word', match: 'cafe', keptAt: 30, recheckAt: null },
  ] });
  expect(source.facts().protection?.kept).toEqual({ total: 2, unreadable: 1 });
});
