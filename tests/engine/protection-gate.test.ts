/**
 * The protection gate (spec §7.4–7.5): selection judges the stored facts, the click judges only the
 * fresh observation's own fields, and a keeping verdict stamps the record with its plan-paced re-check.
 */
import {
  freshSubject, keepRecord, keptStampFor, releaseRecord, releaseTarget, selectionVerdict, storedSubject,
} from '@/engine/protection-gate';
import { createProtectionPort } from '@/engine/protection-port';
import { FakeClock } from '@/governors/clock';
import { calendarPlanDayClock } from '@/governors/plan-day-clock';
import type { ProtectionSettings } from '@/shared/settings-model';
import { compileProtection, protectionVerdict } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord, Observation } from '@/store/types';
import { MS_PER_DAY } from '@/timing/units';
import { memoryStore } from '../kit/store';

const T0 = Date.parse('2026-11-03T12:00:00');
const words = (...ws: string[]): ProtectionSettings => ({
  accounts: [], words: ws.map((text) => ({ text, addedAt: 0 })), wordMatch: 'anywhere', keepVerified: false,
});
const index = (p: ProtectionSettings) => compileProtection(p, 'ready', 1);

let store: KnowledgeStore;
beforeEach(() => { store = memoryStore(); });
afterEach(() => store.close());

const observe = (pk: string, fields: Observation['fields'], at = T0): Observation => {
  const obs: Observation = { accountPk: pk, observedAt: at, source: 'profile', fields };
  store.observe(obs);
  return obs;
};

test('the stored subject carries the folded row; an unseen account has no facts', () => {
  observe('1', { username: 'jane', bio: 'Café owner', isVerified: true });
  expect(storedSubject(store, '1')).toEqual({ pk: '1', username: 'jane', bio: 'Café owner', isVerified: true });
  expect(storedSubject(store, 'nobody')).toEqual({ pk: 'nobody', username: null, bio: undefined, isVerified: undefined });
});

test('a stored bio that matches protects at selection, even when stale', () => {
  observe('1', { username: 'jane', bio: 'my cafe' });
  expect(selectionVerdict(store, '1', index(words('cafe')))).toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
});

test('the click judges the fresh fields only: a body without biography is unknown though the store matches', () => {
  observe('1', { username: 'jane', bio: 'my cafe' }, T0 - MS_PER_DAY);
  const fresh = observe('1', { username: 'jane' });
  expect(storedSubject(store, '1').bio).toBe('my cafe');
  expect(protectionVerdict(freshSubject(fresh, 'jane'), index(words('cafe')))).toEqual({ kind: 'unknown', missing: 'bio' });
});

test('the click sees a new bio the store has not yet folded the old one away from', () => {
  observe('1', { username: 'jane', bio: 'photographer' }, T0 - MS_PER_DAY);
  const fresh: Observation = { accountPk: '1', observedAt: T0, source: 'profile', fields: { bio: 'now a cafe' } };
  expect(selectionVerdict(store, '1', index(words('cafe')))).toEqual({ kind: 'clear' });
  expect(protectionVerdict(freshSubject(fresh, 'jane'), index(words('cafe'))))
    .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
});

test('a null bio or verified flag reads as absent, never as a fact', () => {
  const obs = { accountPk: '1', observedAt: T0, source: 'profile', fields: { bio: null, isVerified: null } } as unknown as Observation;
  expect(freshSubject(obs, 'jane')).toEqual({ pk: '1', username: 'jane', bio: undefined, isVerified: undefined });
});

test('a rule match keeps without a re-check; an unreadable fact re-checks 1, 2, 4, 8 plan-days apart', () => {
  const clock = new FakeClock(T0);
  const port = createProtectionPort({ index: () => index(words('cafe')), clock, dayClock: calendarPlanDayClock({ now: () => clock.now() }) });
  expect(keptStampFor({ kind: 'protected', by: 'account', match: '1' }, T0, 3, port))
    .toEqual({ reason: 'account', match: '1', at: T0, recheckAt: null, checks: 0 });
  const waits: number[] = [];
  let checks = 0;
  for (let i = 0; i < 5; i++) {
    const s = keptStampFor({ kind: 'unknown', missing: 'bio' }, T0, checks, port);
    expect(s).toMatchObject({ reason: 'unreadable-bio', match: null, at: T0 });
    waits.push(Math.round(((s.recheckAt ?? 0) - T0) / MS_PER_DAY));
    checks = s.checks;
  }
  expect(waits).toEqual([1, 2, 4, 8, 8]);
});

test('keep and release move the record; release goes back to where the follow-back evidence puts it', () => {
  const base: FollowRecord = { accountPk: '1', targetPk: null, state: 'unfollow_queued', retryCount: 0, followedAt: 1 };
  store.upsertFollowRecord(base);
  keepRecord(store, base, { reason: 'verified', match: 'verified', at: T0, recheckAt: null, checks: 0 });
  expect(store.getFollowRecord('1')?.state).toBe('kept');
  releaseRecord(store, store.getFollowRecord('1') as FollowRecord);
  expect(store.getFollowRecord('1')?.state).toBe('pending_followback');
  expect(releaseTarget({ ...base, followedBackAt: 5 })).toBe('followed_back');
  expect(releaseTarget({ ...base, followbackObservedAt: 5 })).toBe('followed_back');
});
