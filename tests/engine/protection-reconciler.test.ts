/**
 * The protection reconciler (spec §7.5): one store transaction over the kept records, no Instagram
 * traffic. Exit 1 returns a record no rule protects anymore; Exit 2 sends an unreadable one back
 * to be read when its plan-paced re-check is due; a paused index moves nothing.
 */
import { createProtectionPort } from '@/engine/protection-port';
import { ProtectionReconciler } from '@/engine/protection-reconciler';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ProtectionSettings, ProtectionState } from '@/shared/settings-model';
import { compileProtection } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { MS_PER_DAY } from '@/timing/units';
import { memoryStore } from '../kit/store';

const T0 = Date.parse('2026-11-03T12:00:00');

let store: KnowledgeStore;
let clock: FakeClock;
let rules: ProtectionSettings;
let state: ProtectionState;
let rev: number;
let reconciler: ProtectionReconciler;

beforeEach(() => {
  store = memoryStore();
  clock = new FakeClock(T0);
  rules = { accounts: [], words: [{ text: 'cafe', addedAt: 0 }], wordMatch: 'anywhere', keepVerified: false };
  state = 'ready';
  rev = 1;
  const dayClock = calendarPlanDayClock({ now: () => clock.now() });
  const port = createProtectionPort({ index: () => compileProtection(rules, state, rev), clock, dayClock });
  reconciler = new ProtectionReconciler({ store, port, clock, dayClock });
});
afterEach(() => store.close());

const kept = (pk: string, over: Partial<FollowRecord> = {}): void => {
  store.observe({ accountPk: pk, observedAt: T0, source: 'profile', fields: { username: `u${pk}` } });
  store.upsertFollowRecord({ accountPk: pk, targetPk: null, state: 'kept', retryCount: 0, followedAt: 1,
    unfollowDueAt: 2, keptAt: T0, ...over });
};
const bio = (pk: string, text: string): void => {
  store.observe({ accountPk: pk, observedAt: clock.now(), source: 'profile', fields: { bio: text } });
};
const stateOf = (pk: string) => store.getFollowRecord(pk)?.state;

test('Exit 1: a record no rule protects anymore returns to the lifecycle', () => {
  kept('1', { keptReason: 'bio-word', keptMatch: 'cafe' });
  kept('2', { keptReason: 'bio-word', keptMatch: 'cafe', followedBackAt: 5 });
  bio('1', 'my cafe');
  bio('2', 'my cafe');
  expect(reconciler.reapply('rules')).toEqual({ kept: 2, released: 0, rechecking: 0 });
  rules = { ...rules, words: [] };
  expect(reconciler.reapply('rules')).toEqual({ kept: 0, released: 2, rechecking: 0 });
  expect([stateOf('1'), stateOf('2')]).toEqual(['pending_followback', 'followed_back']);
});

test('Exit 1 on a changed stored fact: the bio no longer matches', () => {
  kept('1', { keptReason: 'bio-word', keptMatch: 'cafe' });
  bio('1', 'photographer');
  expect(reconciler.reapply('day-roll').released).toBe(1);
  expect(stateOf('1')).toBe('pending_followback');
});

test('a rule that now protects an unreadable record restamps it, with no re-check', () => {
  kept('1', { keptReason: 'unreadable-bio', recheckAt: T0 + MS_PER_DAY, checkFailures: 2 });
  rules = { ...rules, accounts: [{ pk: '1', username: 'u1', linkedAt: 1, formerUsernames: [], addedAt: 1, source: 'you', valid: true }] };
  expect(reconciler.reapply('rules')).toEqual({ kept: 1, released: 0, rechecking: 0 });
  expect(store.getFollowRecord('1')).toMatchObject({ state: 'kept', keptReason: 'account', keptMatch: '1', checkFailures: 0 });
  expect(store.getFollowRecord('1')?.recheckAt).toBeUndefined();
});

test('Exit 2: an unreadable record waits for its re-check, then goes back to be read', () => {
  kept('1', { keptReason: 'unreadable-bio', recheckAt: T0 + MS_PER_DAY, checkFailures: 1 });
  expect(reconciler.reapply('day-roll')).toEqual({ kept: 1, released: 0, rechecking: 0 });
  clock.advance(MS_PER_DAY);
  expect(reconciler.reapply('day-roll')).toEqual({ kept: 0, released: 0, rechecking: 1 });
  expect(store.getFollowRecord('1')).toMatchObject({ state: 'unfollow_queued', checkFailures: 1, unfollowDueAt: 2 });
});

test('an unreadable record whose rule needs no fact anymore is released, not re-read', () => {
  kept('1', { keptReason: 'unreadable-bio', recheckAt: T0 + 8 * MS_PER_DAY, checkFailures: 4 });
  rules = { ...rules, words: [] };
  expect(reconciler.reapply('rules').released).toBe(1);
  expect(store.getFollowRecord('1')).toMatchObject({ state: 'pending_followback', checkFailures: 0 });
});

test('a paused index moves nothing (fail closed)', () => {
  kept('1', { keptReason: 'bio-word', keptMatch: 'cafe' });
  rules = { ...rules, words: [] };
  for (const s of ['needs-review', 'unavailable'] as const) {
    state = s;
    expect(reconciler.reapply('rules')).toEqual({ kept: 1, released: 0, rechecking: 0 });
  }
  expect(stateOf('1')).toBe('kept');
});

test('a source stays kept while it is a source', () => {
  kept('1', { keptReason: 'source', keptMatch: '1' });
  store.addTarget({ accountPk: '1', source: 'seed', status: 'active', chainIndex: 0 });
  expect(reconciler.reapply('day-roll').kept).toBe(1);
  expect(stateOf('1')).toBe('kept');
});

test('one pass is one store transaction', () => {
  kept('1', { keptReason: 'bio-word', keptMatch: 'cafe' });
  kept('2', { keptReason: 'bio-word', keptMatch: 'cafe' });
  rules = { ...rules, words: [] };
  let pulses = 0;
  store.onMutation(() => { pulses += 1; });
  reconciler.reapply('rules');
  expect(pulses).toBe(1);
});

test('sync: the graph-open pass, then only on a rules change or a new plan-day', () => {
  kept('1', { keptReason: 'bio-word', keptMatch: 'cafe' });
  bio('1', 'cafe');
  expect(reconciler.sync(clock.now())).not.toBeNull();
  expect(reconciler.sync(clock.now())).toBeNull();
  rev = 2;
  expect(reconciler.sync(clock.now())).toBeNull();
  rules = { ...rules, keepVerified: true };
  expect(reconciler.sync(clock.now())).toEqual({ kept: 1, released: 0, rechecking: 0 });
  expect(reconciler.sync(clock.now())).toBeNull();
  clock.advance(MS_PER_DAY);
  expect(reconciler.sync(clock.now())).toEqual({ kept: 1, released: 0, rechecking: 0 });
  expect(reconciler.sync(clock.now())).toBeNull();
});
