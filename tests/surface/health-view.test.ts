/**
 * The area state machine (spec §10.6–§10.7): states worst first, the activities each area pauses — `exploration`
 * only once the lists area saw `driftConfirmThreshold()` drifted pages, and a drifted list is a compatibility
 * pause, never a rate limit — the summary, the gate over persisted rows, and the revision a write bumps.
 */

import { driftConfirmThreshold } from '@/kernel/derive';
import { createSurfaceHealthSink } from '@/main/services/surface-health-sink';
import { createSurfaceReport } from '@/main/services/surface-report';
import { type AreaView, createSurfaceGate, type DriftRowView, deriveAreas, type HealthRowView, summarize } from '@/surface/health-view';
import { memoryStore } from '../kit/store';

const T = driftConfirmThreshold();
const row = (over: Partial<DriftRowView>): DriftRowView => ({ endpoint: 'profile-graphql', cls: 'recovered', path: 'data.x',
  detail: '{}', hintPattern: null, firstSeenAt: 100, lastSeenAt: 100, seen: 1, ...over });
const read = (over: Partial<HealthRowView>): HealthRowView => ({ day: 'today', endpoint: 'profile-graphql', walls: 0,
  lastReadAt: 50, lastOkAt: 50, ...over });
const area = (areas: readonly AreaView[], name: string): AreaView | undefined => areas.find((a) => a.area === name);
const view = (rows: DriftRowView[], health: HealthRowView[] = []) => deriveAreas(rows, health, 'today', T);

test('nothing read is unseen; a read is ok; a wall today is limited, a wall on another day is not', () => {
  expect(area(view([]), 'profiles')?.state).toBe('unseen');
  expect(area(view([], [read({})]), 'profiles')?.state).toBe('ok');
  expect(area(view([], [read({ walls: 1 })]), 'profiles')?.state).toBe('limited');
  expect(area(view([], [read({ walls: 1, day: 'yesterday' })]), 'profiles')?.state).toBe('ok');
});

describe('profiles', () => {
  test('a recovered read pauses unfollows and relationship reads', () => {
    expect(area(view([row({})]), 'profiles')).toMatchObject({ state: 'paused', paused: ['unfollows', 'relationship-reads'], since: 100 });
  });

  test('an absent relationship key pauses both; an absent bio or verified badge pauses unfollows', () => {
    const rel = row({ cls: 'expected-absent', path: 'data.user.friendship_status.following' });
    expect(area(view([rel]), 'profiles')?.paused).toEqual(['unfollows', 'relationship-reads']);
    for (const path of ['data.user.biography', 'data.user.is_verified']) {
      expect(area(view([row({ cls: 'expected-absent', path })]), 'profiles')).toMatchObject({ state: 'paused', paused: ['unfollows'] });
    }
  });

  test('normalized and novel keys change nothing', () => {
    const quiet = [row({ cls: 'normalized' }), row({ cls: 'novel-key', path: 'data.user.new' })];
    expect(area(view(quiet, [read({})]), 'profiles')?.state).toBe('ok');
  });
});

describe('lists', () => {
  test('one drifted page pauses pruning; exploration waits for the threshold of drifted pages', () => {
    const drift = row({ endpoint: 'followers-list', cls: 'more-without-cursor', path: 'has_more' });
    expect(area(view([drift]), 'lists')?.paused).toEqual(T > 1 ? ['cleanup'] : ['cleanup', 'exploration']);
    expect(area(view([{ ...drift, seen: T }]), 'lists')?.paused).toEqual(['cleanup', 'exploration']);
  });

  test('recovered source rows count toward exploration only', () => {
    const source = row({ endpoint: 'followers-list', cls: 'recovered', path: 'data.users', detail: '{"role":"source-rows"}', seen: T });
    expect(area(view([source]), 'lists')).toMatchObject({ state: 'paused', paused: ['exploration'] });
  });

  test('a drifted list is never a rate limit', () => {
    const drift = row({ endpoint: 'followers-list', cls: 'cursor-veto', path: 'next_max_id', seen: T });
    expect(area(view([drift], [read({ endpoint: 'followers-list', walls: 2 })]), 'lists')?.state).toBe('paused');
  });
});

test('a repeated failure newer than the last good read is unreadable; an older one is not', () => {
  const broken = row({ endpoint: 'activity-feed', cls: 'mismatch', seen: T, lastSeenAt: 200 });
  expect(area(view([broken], [read({ endpoint: 'activity-feed', lastOkAt: 150 })]), 'notifications')?.state).toBe('unreadable');
  expect(area(view([broken], [read({ endpoint: 'activity-feed', lastOkAt: 250 })]), 'notifications')?.state).toBe('ok');
  const lost = row({ endpoint: 'activity-feed', cls: 'unrouted', seen: T, lastSeenAt: 300 });
  expect(area(view([lost]), 'notifications')?.state).toBe('unreadable');
  expect(area(view([{ ...lost, hintPattern: 'NewFeedQuery' }]), 'notifications')?.state).toBe('adapting');
});

test('the summary carries the worst state, the paused union and a line per area that needs one', () => {
  const s = summarize(view([row({}), row({ endpoint: 'activity-feed' })], [read({ endpoint: 'mutation' })]), 7);
  expect(s).toMatchObject({ revision: 7, worst: 'paused', adapting: true, paused: ['unfollows', 'relationship-reads'] });
  expect(s.areas).toMatchObject({ profiles: 'paused', notifications: 'adapting', 'follow-actions': 'ok', lists: 'unseen' });
  expect(s.attention.map((a) => [a.area, a.state])).toEqual([['profiles', 'paused'], ['notifications', 'adapting']]);
});

test('the gate pauses exactly the activities some area pauses', () => {
  const gate = createSurfaceGate(() => view([row({ endpoint: 'friend-requests', cls: 'rows-unreadable' })]));
  expect(gate.paused('follow-back-decisions')).toBe(true);
  expect(gate.paused('unfollows')).toBe(false);
});

test('over a store: drift pauses the gate, the revision moves, clean reads open it, a new report agrees', () => {
  const store = memoryStore();
  const day = { window: () => ({ key: 'd', startsAt: 0, endsAt: 1e12, quietMinute: 0 }), dayKey: () => 'd', onRoll: () => () => {} };
  const clock = { now: () => 1_000 };
  const timers: Array<() => void> = [];
  const sink = createSurfaceHealthSink({ store, surfaceId: 's', day, clock, scrub: () => null,
    after: (_ms, fn) => { timers.push(fn); return () => {}; } });
  const report = createSurfaceReport({ store, surfaceId: 's', day, clock });
  const before = report.summary().revision;
  sink.drift({ endpoint: 'profile-graphql', cls: 'expected-absent', path: 'data.user.friendship_status.following', detail: {} }, 900);
  expect(report.summary().revision).toBeGreaterThan(before);
  expect(report.gate.paused('unfollows')).toBe(true);
  expect(createSurfaceReport({ store, surfaceId: 's', day, clock }).gate.paused('relationship-reads')).toBe(true);
  for (let i = 0; i < T; i += 1) sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 950 + i);
  for (const fn of timers.splice(0)) fn();
  expect(report.gate.paused('unfollows')).toBe(false);
  expect(report.summary().areas.profiles).toBe('ok');
});
