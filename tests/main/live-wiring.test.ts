/**
 * The live wiring's projection sources (spec §12.9, §13): the feed shaped from the graph's store over the plan-day
 * clock, stable while nothing changed; the expiry at the earlier of the plan-day roll and the census freshness end
 * (the prune source's declaration); the recovery episode and the runtime's resume and quit as feed moments; a
 * built Foundation pushing the real feed when a write settles; and the resume target riding the status.
 */

import { type FrontierSource, SourceFrontier, type SourceFrontierSnapshot } from '@/engine/source-frontier';
import type { PlanDayClock } from '@/kernel/plan';
import type { BuiltGraph } from '@/main/services/graph-types';
import { censusFreshEnd, liveSources, liveWiringParts } from '@/main/services/live-wiring';
import type { FeedView } from '@/shared/feed';
import type { KnowledgeStore } from '@/store/knowledge-store';
import * as logger from '@/utils/logger';
import { cleanupMainHarness, foundationStore, newFoundation } from '../kit/main-harness';
import { openTestStore } from '../kit/store';

afterAll(cleanupMainHarness);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The plan's census freshness the sources are handed (its patience wait: the default four days). */
const CENSUS_FRESH_MS = 4 * 86_400_000;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % DAY) + 10 * HOUR;

const utcDays: PlanDayClock = {
  window: (t) => {
    const start = t - (((t % DAY) + DAY) % DAY);
    return { key: `d${start / DAY}`, startsAt: start, endsAt: start + DAY, quietMinute: 0 };
  },
  dayKey: (t) => `d${Math.floor(t / DAY)}`,
  onRoll: () => () => {},
};

let store: KnowledgeStore;
beforeEach(() => {
  store = openTestStore();
  store.setOwnPk('own');
});
afterEach(() => store.close());

function follow(pk: string, at: number): void {
  const intent = store.beginEffectIntent({ accountPk: pk, username: `u${pk}`, action: 'follow', channel: 'growth', at });
  store.markEffectDispatched(intent.id, at);
  store.settleEffectIntent(intent.id, { at, result: 'ok', ledger: 'none' });
}

function sources(over: { now?: () => number; incidents?: { at: number; reason: string }[]; prune?: { scanReady: boolean; scanAt: number | null } } = {}) {
  const prune = over.prune ?? { scanReady: false, scanAt: null };
  return liveSources(
    { store, ownPk: 'own', pruneEngine: { status: () => prune } },
    () => ({ incidents: over.incidents ?? [] }),
    { planDay: utcDays, censusFreshMs: () => CENSUS_FRESH_MS, now: over.now ?? (() => NOW) },
  );
}

describe('kept rows (SB: the live column narrates protection)', () => {
  test('an account protection kept from an unfollow shows in the feed at the time it was kept', () => {
    store.upsertFollowRecord({ accountPk: 'k', targetPk: null, state: 'unfollow_queued', retryCount: 0, followedAt: NOW - DAY, unfollowDueAt: NOW });
    store.observe({ accountPk: 'k', observedAt: NOW - DAY, source: 'profile', fields: { username: 'friend' } });
    store.followRecords.review([{ pk: 'k', move: 'keep', stamp: { reason: 'account', match: 'friend', at: NOW - 3 * MIN, recheckAt: null, checks: 0 } }]);
    const kept = sources().feed().items.filter((i) => i.kind === 'kept');
    expect(kept).toEqual([{ id: `kept:k:${NOW - 3 * MIN}`, at: NOW - 3 * MIN, kind: 'kept', person: { pk: 'k', username: 'friend' }, reason: 'account' }]);
  });
});

test("the feed reads the graph's store and keeps its view while only the clock moves", () => {
  let now = NOW;
  const live = sources({ now: () => now });
  follow('a', NOW - 5 * MIN);
  const first = live.feed();
  expect(first.items.map((i) => i.kind)).toEqual(['followed']);
  expect(first.days?.[0]).toEqual({ key: utcDays.window(NOW).key, startsAt: utcDays.window(NOW).startsAt });
  now += 2 * MIN;
  expect(live.feed()).toBe(first);
  follow('b', now - MIN);
  const second: FeedView = live.feed();
  expect(second).not.toBe(first);
  expect(second.items).toHaveLength(1);
  expect(second.items[0]).toMatchObject({ kind: 'followed', people: [{ pk: 'b' }, { pk: 'a' }] });
});

test("the last launch catch-up is the feed's caught-up row, and its window replaces the last-quit divider", () => {
  const away = { sweepId: 3, from: NOW - 5 * DAY, to: NOW - MIN, isReturn: true, followers: { before: 10, after: 14 },
    following: { before: 5, after: 5, outsideEpo: null }, newFollowers: 4, followBacks: 2, lostIdentified: 1, unattributed: 0,
    requestsWaiting: null, gaps: { feed: false, head: false }, backfilled: null, journalPending: 0 };
  store.reopen.set({ v: 1, feed: null, head: null, requests: null, lastSweep: null, lastCatchUp: away, following: null });
  const view = sources({ incidents: [{ at: NOW - 2 * DAY, reason: 'intentional-shutdown' }] }).feed();
  expect(view.awayFrom).toBe(NOW - 5 * DAY);
  expect(view.items.find((i) => i.kind === 'caught-up')).toMatchObject({ at: NOW - MIN,
    summary: { awayFrom: NOW - 5 * DAY, checkedAt: NOW - MIN, newFollowers: 4, followBacks: 2, left: 1 } });
});

test('the expiry is the next plan-day roll, or the census freshness end when that comes first', () => {
  expect(sources().expiresAt()).toBe(utcDays.window(NOW).endsAt);
  const scanAt = NOW - CENSUS_FRESH_MS + HOUR;
  expect(sources({ prune: { scanReady: true, scanAt } }).expiresAt()).toBe(scanAt + CENSUS_FRESH_MS + 1);
  expect(sources({ prune: { scanReady: false, scanAt } }).expiresAt()).toBe(utcDays.window(NOW).endsAt);
});

test('a census still runnable past its end is re-checked at the next push; a spent one declares nothing', () => {
  expect(censusFreshEnd({ scanReady: true, scanAt: NOW - CENSUS_FRESH_MS - 5 }, NOW, CENSUS_FRESH_MS)).toBe(NOW + 1);
  expect(censusFreshEnd({ scanReady: true, scanAt: null }, NOW, CENSUS_FRESH_MS)).toBeNull();
  expect(censusFreshEnd({ scanReady: false, scanAt: NOW }, NOW, CENSUS_FRESH_MS)).toBeNull();
});

test("the recovery ladder's open episode, else its last one, reads as slowed down; a resume and a quit come from the runtime", () => {
  store.setRecoveryLastIncident(JSON.stringify({ enteredAt: NOW - 5 * HOUR, resolvedAt: NOW - 4 * HOUR, attempts: 2, kindTally: {}, healed: null }));
  const live = sources({ incidents: [
    { at: NOW - 3 * HOUR, reason: 'intentional-shutdown' },
    { at: NOW - 2 * HOUR, reason: 'process-recovery-start' },
    { at: NOW - 9 * HOUR, reason: 'intentional-shutdown' },
  ] });
  const closed = live.feed();
  expect(closed.items).toEqual([
    { id: `resumed:${NOW - 2 * HOUR}`, at: NOW - 2 * HOUR, kind: 'resumed', after: 'restart' },
    { id: `slowed:${NOW - 5 * HOUR}`, at: NOW - 5 * HOUR, kind: 'slowed-down', until: null },
  ]);
  expect(closed.awayFrom).toBe(NOW - 3 * HOUR);

  store.setRecoveryState(JSON.stringify({ phase: 'holding', attempt: 1, holdUntil: NOW + HOUR, enteredAt: NOW - HOUR, kindTally: {} }));
  expect(live.feed().items[0]).toEqual({ id: `slowed:${NOW - HOUR}`, at: NOW - HOUR, kind: 'slowed-down', until: NOW + HOUR });
});

test('unreadable recovery meta is reported once and adds no row', () => {
  const warnings: string[] = [];
  logger.setLevel('warn');
  logger.setSink((level, message) => { if (level === 'warn') warnings.push(message); });
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    store.setRecoveryState('{not json');
    const live = sources();
    expect(live.feed().items).toEqual([]);
    expect(live.feed().items).toEqual([]);
    expect(warnings.filter((m) => m.startsWith('live: unreadable recovery meta'))).toHaveLength(1);
  } finally {
    quiet.mockRestore();
    logger.setSink(null);
    logger.setLevel('error');
  }
});

test('a built Foundation pushes the real feed when a write settles', async () => {
  const feeds: FeedView[] = [];
  const { foundation } = newFoundation({ push: (channel, payload) => { if (channel === 'feed') feeds.push(payload as FeedView); } });
  await foundation.ensureBuilt();
  expect(feeds.at(-1)?.items).toEqual([]);
  const real = foundationStore(foundation);
  const intent = real.beginEffectIntent({ accountPk: 'p1', username: 'jane', action: 'follow', channel: 'manual', at: Date.now() });
  real.markEffectDispatched(intent.id, Date.now());
  real.settleEffectIntent(intent.id, { at: Date.now(), result: 'ok', ledger: 'none' });
  for (let i = 0; i < 100 && (feeds.at(-1)?.items.length ?? 0) === 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(feeds.at(-1)?.items).toEqual([
    expect.objectContaining({ kind: 'followed', via: 'you', people: [{ pk: 'p1', username: 'jane' }] }),
  ]);
  await foundation.dispose();
});

describe('the resume target', () => {
  const graphOf = (s: KnowledgeStore): BuiltGraph => ({ store: s, clock: { now: () => NOW } }) as unknown as BuiltGraph;
  const contributor = (frontier?: SourceFrontier) => {
    const parts = liveWiringParts(frontier === undefined ? {} : { frontier });
    expect(parts.startupSteps).toEqual([]);
    const [resume] = parts.statusContributors;
    expect(resume.name).toBe('resumeTarget');
    return resume;
  };
  const due = (pk: string): FrontierSource => ({ pk, source: 'discovered', status: 'ready', resumeAt: NOW - 1, lastVisitedAt: 0,
    totalFollows: 0, visit: null, lastReason: null });
  const frontierState = (currentTargetPk: string | null, sources: FrontierSource[]): void => {
    const snapshot: SourceFrontierSnapshot = { version: 1, currentTargetPk, sources, recentFollowSources: [], totalFollows: 0 };
    store.setSourceFrontierState(JSON.stringify(snapshot));
  };

  test('none before a graph exists, or when nothing is left to resume', () => {
    expect(contributor().contribute(null, NOW)).toEqual({ resumeTarget: null });
    expect(contributor().contribute(graphOf(store), NOW)).toEqual({ resumeTarget: null });
  });

  test("the engine's frontier: the visit in progress, else the next source, with its username", () => {
    store.observe({ accountPk: 'p1', observedAt: NOW, source: 'profile', fields: { username: 'lumen' } });
    store.observe({ accountPk: 'p2', observedAt: NOW, source: 'profile', fields: { username: 'atlas' } });
    store.addTarget({ accountPk: 'p1', source: 'discovered', status: 'active', chainIndex: 1 });
    const engineFrontier = new SourceFrontier({ store, clock: { now: () => NOW } as never });
    frontierState('p1', [due('p1'), due('p2')]);
    expect(contributor(engineFrontier).contribute(graphOf(store), NOW)).toEqual({ resumeTarget: { pk: 'p1', username: 'lumen' } });
    frontierState(null, [due('p2')]);
    expect(contributor(engineFrontier).contribute(graphOf(store), NOW)).toEqual({ resumeTarget: { pk: 'p2', username: 'atlas' } });
  });

  test('the pick is ranked again when the frontier or the targets change, and each new minute, never otherwise', () => {
    store.observe({ accountPk: 'p3', observedAt: NOW, source: 'profile', fields: { username: 'three' } });
    frontierState(null, [due('p3')]);
    const engineFrontier = new SourceFrontier({ store, clock: { now: () => NOW } as never });
    const next = jest.spyOn(engineFrontier, 'next');
    const resume = contributor(engineFrontier);
    resume.contribute(graphOf(store), NOW);
    resume.contribute(graphOf(store), NOW + 1_000);
    expect(next).toHaveBeenCalledTimes(1);
    resume.contribute(graphOf(store), NOW + MIN);
    expect(next).toHaveBeenCalledTimes(2);
    store.addTarget({ accountPk: 'p4', source: 'discovered', status: 'active', chainIndex: 4 });
    resume.contribute(graphOf(store), NOW + MIN);
    expect(next).toHaveBeenCalledTimes(3);
    frontierState(null, [due('p3'), due('p4')]);
    resume.contribute(graphOf(store), NOW + MIN);
    expect(next).toHaveBeenCalledTimes(4);
  });

  test('with no frontier handed in, a read-only one over the graph store answers, and the peek writes nothing', () => {
    store.observe({ accountPk: 'p9', observedAt: NOW, source: 'profile', fields: { username: 'nine' } });
    frontierState(null, [due('p9')]);
    const before = store.getSourceFrontierState();
    expect(contributor().contribute(graphOf(store), NOW)).toEqual({ resumeTarget: { pk: 'p9', username: 'nine' } });
    expect(store.getSourceFrontierState()).toBe(before);
    expect(store.getTarget('p9')).toBeNull();
  });
});
