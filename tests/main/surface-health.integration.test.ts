/**
 * The production surface sink over a real store (spec §10.7): tallies buffer and land on the throttle's
 * trailing edge, a plan-day roll and teardown; a first sighting lands at once with a scrubbed sample (≤ the
 * day's cap, held to the leak rules); clean canonical reads resolve drift; the meter round-trips through meta;
 * the gate stops an unfollow before any read; `status.surface` moves with the store.
 */


import { ActionDeferredError } from '@/adapter/errors';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { FakeClock } from '@/governors/clock';
import { ReadBudget } from '@/governors/read-budget';
import type { PlanDayClock, PlanDayWindow } from '@/kernel/plan';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { createClickReview } from '@/main/services/click-review';
import { createSurfaceHealthSink, type SurfaceHealthSinkDeps } from '@/main/services/surface-health-sink';
import { createSurfaceReport } from '@/main/services/surface-report';
import { liveSurfaceReporter, surfaceGateOf } from '@/main/services/surface-wiring';
import { effectiveFromV1 } from '@/settings/effective';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord } from '@/store/types';
import { scrubSample } from '@/surface/lab/sample';
import { structuralLeaks } from '@/surface/lab/structural-leak';
import { SurfaceMeter } from '@/surface/meter';
import type { DriftSignal } from '@/surface/sink';
import { builtFoundation, cleanupMainHarness, foundationStore } from '../kit/main-harness';
import { readLimits } from '../kit/read-limits';
import { memoryStore } from '../kit/store';

const S = '2026-08-12';
const DAY_MS = 86_400_000;

/** A plan-day clock whose day changes only when the test rolls it. */
function manualDay(): PlanDayClock & { roll(): void } {
  let index = 0;
  const listeners = new Set<(w: PlanDayWindow) => void>();
  const windowOf = (): PlanDayWindow => ({ key: `day-${index}`, startsAt: index * DAY_MS, endsAt: (index + 1) * DAY_MS,
    quietMinute: 0 });
  return {
    window: windowOf, dayKey: () => windowOf().key,
    onRoll(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    roll() { index += 1; for (const fn of listeners) fn(windowOf()); },
  };
}

function harness(over: Partial<SurfaceHealthSinkDeps> = {}) {
  const store: KnowledgeStore = over.store ?? memoryStore();
  const day = manualDay();
  let now = 1_000;
  const timers: Array<() => void> = [];
  const meter = over.meter ?? new SurfaceMeter();
  const sink = createSurfaceHealthSink({ store, surfaceId: S, day, clock: { now: () => now }, scrub: scrubSample,
    threshold: 2, meter, after: (_ms, fn) => { timers.push(fn); return () => timers.splice(timers.indexOf(fn), 1); }, ...over });
  const fire = (): void => { for (const fn of timers.splice(0)) fn(); };
  return { store, day, sink, fire, meter, tick: (ms: number) => { now += ms; } };
}

const recovered = (sample?: () => unknown): DriftSignal => ({ endpoint: 'profile-graphql', cls: 'recovered', path: 'data.wrap.user',
  detail: { got: 'object' }, hint: { role: 'profile-user', pattern: 'data.wrap.user', subject: null, agreed: true }, sample });
const realBody = { data: { wrap: { user: { pk: '123456789012', username: 'real.handle', full_name: 'Real Person',
  follower_count: 4321, profile_pic_url: 'https://scontent.cdninstagram.com/v/x.jpg' } } } };

test('read tallies land on the trailing edge, keyed by the plan-day', () => {
  const h = harness();
  h.sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 1_000);
  h.sink.read('profile-graphql', 'failed', { rows: 2, fields: 1 }, 1_100);
  expect(h.store.surface.health(S, '')).toEqual([]);
  h.fire();
  expect(h.store.surface.health(S, '')).toEqual([expect.objectContaining({ day: 'day-0', endpoint: 'profile-graphql',
    canonical: 1, failed: 1, rowIssues: 2, fieldIssues: 1, lastOkAt: 1_000, lastFailAt: 1_100 })]);
});

test('a first sighting lands at once with a scrubbed sample that breaks no leak rule and keeps no real value', () => {
  const h = harness();
  h.sink.drift(recovered(() => realBody), 1_000);
  const [row] = h.store.surface.openSignatures(S);
  expect(row).toMatchObject({ cls: 'recovered', path: 'data.wrap.user', seen: 1, hintPattern: 'data.wrap.user' });
  // The wrapped record is unknown to the scrub shape, so it collapses to its type: nothing real can remain.
  expect(row?.sample).not.toBeNull();
  const sample = row?.sample ?? '';
  expect(structuralLeaks(sample)).toEqual([]);
  for (const real of ['123456789012', 'real.handle', 'Real Person', '4321', 'cdninstagram']) expect(sample).not.toContain(real);
});

test('samples stop at the day cap; a roll flushes and opens a new day', () => {
  const h = harness();
  for (let i = 0; i < SURFACE_BOUNDS.samplesPerDay + 2; i += 1) {
    h.sink.drift({ ...recovered(() => ({ data: { user: { pk: '1' } } })), path: `p${i}` }, 1_000 + i);
  }
  expect(h.store.surface.samplesSince(S, 0)).toBe(SURFACE_BOUNDS.samplesPerDay);
  h.sink.read('activity-feed', 'wall', { rows: 0, fields: 0 }, 1_500);
  h.day.roll();
  expect(h.store.surface.health(S, '').map((r) => [r.day, r.walls])).toEqual([['day-0', 1]]);
});

test('clean canonical reads resolve a drift signature after the threshold, and the gate opens on persisted state', () => {
  const h = harness();
  h.sink.drift(recovered(), 1_000);
  h.sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 1_100);
  h.sink.read('profile-graphql', 'canonical', { rows: 0, fields: 1 }, 1_200);
  h.fire();
  expect(h.store.surface.openSignatures(S)).toHaveLength(1);
  h.sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 1_300);
  h.fire();
  expect(h.store.surface.openSignatures(S)).toEqual([]);
});

test('teardown flushes; nothing lands after it', () => {
  const h = harness();
  h.sink.read('followers-list', 'canonical', { rows: 0, fields: 0 }, 1_000);
  h.sink.dispose();
  h.sink.read('followers-list', 'canonical', { rows: 0, fields: 0 }, 1_100);
  h.sink.drift(recovered(), 1_200);
  expect(h.store.surface.health(S, '').map((r) => r.canonical)).toEqual([1]);
  expect(h.store.surface.openSignatures(S)).toEqual([]);
});

test('an idle open writes nothing; the first report resolves the replaced surface and keeps the meter unwritten', () => {
  const store = memoryStore();
  store.surface.upsertSignal({ signature: 'old|x', surfaceId: 'old', endpoint: 'profile-graphql', cls: 'mismatch',
    path: 'data', detail: '{}', at: 1 });
  const before = store.surface.revision;
  const h = harness({ store });
  h.sink.dispose();
  expect(store.surface.revision).toBe(before);
  expect(store.surface.meter()).toBeNull();
  const live = harness({ store });
  live.sink.read('profile-graphql', 'canonical', { rows: 0, fields: 0 }, 1_000);
  expect(store.surface.openSignatures('old')).toEqual([]);
});

test('the meter round-trips through meta.surface_meter; a corrupt one starts cold', () => {
  const store = memoryStore();
  const first = harness({ store });
  first.meter.record('list-page', 120);
  first.meter.record('list-page', 80);
  first.sink.flush();
  const warm = new SurfaceMeter();
  harness({ store, meter: warm });
  expect(warm.summary('list-page')).toMatchObject({ n: 2, p50: 80 });
  store.surface.setMeter('{not json');
  const cold = new SurfaceMeter();
  harness({ store, meter: cold });
  expect(cold.summary('list-page').n).toBe(0);
});

test('the hint book and the identity oracle read the store', () => {
  const h = harness();
  h.sink.drift({ ...recovered(), hint: { role: 'profile-user', pattern: 'data.wrap.user', subject: 'pk-1', agreed: true } }, 1);
  h.sink.drift({ ...recovered(), hint: { role: 'profile-user', pattern: 'data.wrap.user', subject: 'pk-2', agreed: true } }, 2);
  expect(h.sink.patterns('profile-graphql', 'profile-user')).toEqual(['data.wrap.user']);
  expect(h.sink.learnedOps()).toEqual([]);
  h.store.observe({ accountPk: '42', observedAt: 1, source: 'profile', fields: { username: 'user_a1' } });
  expect(h.sink.usernameOf('42')).toBe('user_a1');
  expect(h.sink.usernameOf('43')).toBeUndefined();
});

describe('the gate at the click and status.surface over a built graph', () => {
  afterAll(cleanupMainHarness);

  test('a drifted relationship key defers an unfollow before any read; the record is untouched', async () => {
    const store = memoryStore();
    const clock = new FakeClock(Date.UTC(2026, 10, 3, 12));
    const report = createSurfaceReport({ store, surfaceId: S, day: manualDay(), clock });
    store.surface.upsertSignal({ signature: 'rel', surfaceId: S, endpoint: 'profile-graphql', cls: 'expected-absent',
      path: 'data.user.friendship_status.following', detail: '{}', at: clock.now() });
    const record: FollowRecord = { accountPk: 'a', targetPk: null, state: 'unfollow_queued', followedAt: 1, retryCount: 0,
      checkFailures: 0 };
    store.upsertFollowRecord(record);
    const before = store.getFollowRecord('a');
    const budget = new ReadBudget({ store, clock, limits: readLimits() });
    const visit = jest.fn();
    const err = await createClickReview({ store, ownPk: 'me', clock, readBudget: budget, profiles: () => ({ visit }),
      settings: () => effectiveFromV1(DEFAULT_SETTINGS), protection: () => UNCONFIGURED_PROTECTION, signal: () => undefined,
      active: async () => true, surfaceGate: report.gate })
      .prepareProfile('alice', 'a', 'unfollow').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ActionDeferredError);
    expect(visit).not.toHaveBeenCalled();
    expect(budget.snapshot().debits).toEqual([]);
    expect(store.getFollowRecord('a')).toEqual(before);
  });

  test('status.surface moves with the store, and the live report follows the graph', async () => {
    const { foundation: f } = await builtFoundation();
    const first = (await f.status()).surface;
    expect(first?.worst).toBe('unseen');
    expect(liveSurfaceReporter()).not.toBeNull();
    foundationStore(f).surface.upsertSignal({ signature: 'x', surfaceId: S, endpoint: 'followers-list',
      cls: 'more-without-cursor', path: 'has_more', detail: '{}', at: Date.now() });
    const next = (await f.status()).surface;
    expect(next?.areas.lists).toBe('paused');
    expect(next?.paused).toContain('cleanup');
    expect(next?.revision).toBeGreaterThan(first?.revision ?? Number.POSITIVE_INFINITY);
    // A consumer built before the surface wiring resolves the same graph's gate at each ask.
    expect(surfaceGateOf(foundationStore(f)).paused('cleanup')).toBe(true);
    expect(surfaceGateOf(memoryStore()).paused('cleanup')).toBe(false);
    await f.dispose();
    expect(liveSurfaceReporter()).toBeNull();
  });
});
