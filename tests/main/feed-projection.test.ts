/**
 * The feed shaper (spec §12.9, Appendix C.3, law L-FEED): every settled write becomes the row its channel and
 * result say; same-kind rows group within one session boundary under the OLDEST member's id; follow-backs never
 * repeat as new followers; the window is whole plan-days; runtime, recovery, Boost, catch-up and kept moments
 * join when their ports provide them; no session rows; at most the feed limit, newest first.
 */

import fc from 'fast-check';
import { LIVE } from '@/kernel/live-policy';
import type { PlanDayClock } from '@/kernel/plan';
import { type FeedContext, type FeedReads, feedDays, notBuiltFeed, shapeFeed } from '@/main/modules/feed-projection';
import type { FeedItem } from '@/shared/feed';
import type { EdgeFeedRow, EffectFeedRow, FollowBackFeedRow, LostFollowersRow } from '@/store/repos/feed-reads';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000 - (1_800_000_000_000 % DAY) + 15 * HOUR;

/** UTC days: a plan-day clock that needs no time zone. */
const utcDays: Pick<PlanDayClock, 'window'> = {
  window: (t) => {
    const start = t - (((t % DAY) + DAY) % DAY);
    return { key: `d${start / DAY}`, startsAt: start, endsAt: start + DAY, quietMinute: 0 };
  },
};

interface Rows {
  effects?: EffectFeedRow[];
  backs?: FollowBackFeedRow[];
  fresh?: EdgeFeedRow[];
  lost?: LostFollowersRow[];
}

/** Reads that honour the bound and the limit as the SQL does, over fixed rows. */
function reads(rows: Rows): FeedReads & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const newest = <T>(list: T[], at: (r: T) => number, since: number, limit?: number): T[] =>
    list.filter((r) => at(r) >= since).sort((a, b) => at(b) - at(a)).slice(0, limit);
  return {
    calls,
    settledEffects: (since, limit) => { calls.effects = [since, limit]; return newest(rows.effects ?? [], (r) => r.settledAt, since, limit); },
    followBacks: (since, limit) => { calls.backs = [since, limit]; return newest(rows.backs ?? [], (r) => r.at, since, limit); },
    newFollowers: (own, since, limit) => { calls.fresh = [own, since, limit]; return newest(rows.fresh ?? [], (r) => r.at, since, limit); },
    lostFollowerCount: (own, since) => { calls.lost = [own, since]; return newest(rows.lost ?? [], (r) => r.at, since); },
  };
}

const ctx = (over: Partial<FeedContext> = {}): FeedContext => ({
  now: NOW, ownPk: 'own', baselineAt: NOW - 30 * DAY, planDay: utcDays, incidents: [], recoveryIncident: null,
  awayFrom: null, ...over,
});

const effect = (n: number, over: Partial<EffectFeedRow> = {}): EffectFeedRow => ({
  id: `i${n}`, pk: `p${n}`, username: `u${n}`, action: 'follow', channel: 'growth', result: 'ok',
  settledAt: NOW - n * MIN, unfollowReason: null, ...over,
});

const kinds = (items: readonly FeedItem[]): string[] => items.map((i) => i.kind);

describe('settled writes', () => {
  test('each channel and result reads as its row', () => {
    const view = shapeFeed(reads({ effects: [
      effect(1),
      effect(40, { result: 'simulated' }),
      effect(80, { channel: 'manual' }),
      effect(120, { action: 'unfollow', unfollowReason: 'no-followback' }),
      effect(160, { action: 'unfollow', unfollowReason: 'hold-expired' }),
      effect(200, { action: 'unfollow' }),
      effect(240, { action: 'unfollow', channel: 'prune' }),
      effect(280, { action: 'unfollow', channel: 'manual', result: 'simulated' }),
      effect(320, { action: 'accept', channel: 'accept-request' }),
      effect(360, { action: 'accept', channel: 'accept-request', result: 'simulated' }),
      effect(400, { result: 'fail' }),
      effect(440, { action: 'unfollow', result: 'expired' }),
    ] }), ctx());
    const person = (n: number) => ({ pk: `p${n}`, username: `u${n}` });
    expect(view.items).toEqual([
      { id: 'effect:i1', at: NOW - MIN, kind: 'followed', people: [person(1)], via: 'plan', practice: false },
      { id: 'effect:i40', at: NOW - 40 * MIN, kind: 'followed', people: [person(40)], via: 'plan', practice: true },
      { id: 'effect:i80', at: NOW - 80 * MIN, kind: 'followed', people: [person(80)], via: 'you', practice: false },
      { id: 'effect:i120', at: NOW - 120 * MIN, kind: 'unfollowed', people: [person(120)], why: 'no-follow-back', practice: false },
      { id: 'effect:i160', at: NOW - 160 * MIN, kind: 'unfollowed', people: [person(160)], why: 'after-follow-back', practice: false },
      { id: 'effect:i200', at: NOW - 200 * MIN, kind: 'unfollowed', people: [person(200)], why: 'other', practice: false },
      { id: 'effect:i240', at: NOW - 240 * MIN, kind: 'unfollowed', people: [person(240)], why: 'clean-up', practice: false },
      { id: 'effect:i280', at: NOW - 280 * MIN, kind: 'unfollowed', people: [person(280)], why: 'you', practice: true },
      { id: 'effect:i320', at: NOW - 320 * MIN, kind: 'request-accepted', people: [person(320)] },
      { id: 'effect:i400', at: NOW - 400 * MIN, kind: 'not-done', action: 'follow', person: person(400), why: 'error' },
      { id: 'effect:i440', at: NOW - 440 * MIN, kind: 'not-done', action: 'unfollow', person: person(440), why: 'unconfirmed' },
    ]);
  });

  test('a follow inside the Boost window reads as Boost; one after it ended does not', () => {
    const boost = { startedAt: NOW - 3 * HOUR, endsAt: NOW + 9 * HOUR, endedAt: NOW - HOUR, endReason: 'user' as const };
    const view = shapeFeed(reads({ effects: [effect(30), effect(150)] }), ctx({ boost }));
    expect(view.items.filter((i) => i.kind === 'followed').map((i) => [i.id, i.kind === 'followed' && i.via]))
      .toEqual([['effect:i30', 'plan'], ['effect:i150', 'boost']]);
    expect(view.items.filter((i) => i.kind === 'boost')).toEqual([
      { id: `boost:${boost.startedAt}:ended`, at: NOW - HOUR, kind: 'boost', edge: 'ended', endsAt: null, why: 'user' },
      { id: `boost:${boost.startedAt}:started`, at: NOW - 3 * HOUR, kind: 'boost', edge: 'started', endsAt: NOW + 9 * HOUR, why: null },
    ]);
  });
});

describe('grouping', () => {
  test("consecutive same-kind rows inside one session boundary share the oldest member's id", () => {
    const view = shapeFeed(reads({ effects: [effect(1), effect(10), effect(20)] }), ctx());
    expect(view.items).toEqual([{
      id: 'effect:i20', at: NOW - MIN, kind: 'followed', via: 'plan', practice: false,
      people: [{ pk: 'p1', username: 'u1' }, { pk: 'p10', username: 'u10' }, { pk: 'p20', username: 'u20' }],
    }]);
  });

  test('another kind between them, a longer gap, a different source or practice, or a full group starts a new row', () => {
    const gap = LIVE.GROUP_WINDOW_MS / MIN + 5;
    const between = shapeFeed(reads({ effects: [effect(1), effect(5, { action: 'unfollow' }), effect(9)] }), ctx());
    expect(kinds(between.items)).toEqual(['followed', 'unfollowed', 'followed']);
    expect(shapeFeed(reads({ effects: [effect(1), effect(1 + gap)] }), ctx()).items).toHaveLength(2);
    expect(shapeFeed(reads({ effects: [effect(1), effect(2, { channel: 'manual' })] }), ctx()).items).toHaveLength(2);
    expect(shapeFeed(reads({ effects: [effect(1), effect(2, { result: 'simulated' })] }), ctx()).items).toHaveLength(2);
    const many = Array.from({ length: LIVE.GROUP_PEOPLE_MAX + 3 }, (_, i) => effect(i + 1));
    const full = shapeFeed(reads({ effects: many }), ctx()).items;
    expect(full.map((i) => (i.kind === 'followed' ? i.people.length : 0))).toEqual([3, LIVE.GROUP_PEOPLE_MAX]);
  });

  test('a group keeps its id as newer members join', () => {
    const before = shapeFeed(reads({ effects: [effect(5), effect(9)] }), ctx()).items;
    const after = shapeFeed(reads({ effects: [effect(1), effect(5), effect(9)] }), ctx()).items;
    expect(after.map((i) => i.id)).toEqual(before.map((i) => i.id));
  });
});

describe('followers', () => {
  test('a follow-back never repeats as a new follower; new followers start after the baseline', () => {
    const backs: FollowBackFeedRow[] = [
      { pk: 'b1', username: 'bob', at: NOW - 2 * HOUR, dated: true, followedAt: NOW - 50 * HOUR },
      { pk: 'b2', username: null, at: NOW - 3 * HOUR, dated: false, followedAt: NOW - 50 * HOUR },
    ];
    const fresh: EdgeFeedRow[] = [
      { pk: 'b1', username: 'bob', at: NOW - 2 * HOUR, dated: true },
      { pk: 'n1', username: 'nina', at: NOW - 5 * HOUR, dated: true },
    ];
    const r = reads({ backs, fresh });
    const view = shapeFeed(r, ctx({ baselineAt: NOW - 6 * HOUR }));
    expect(view.items).toEqual([
      { id: `followed-back:b1:${NOW - 2 * HOUR}`, at: NOW - 2 * HOUR, kind: 'followed-back', person: { pk: 'b1', username: 'bob' },
        afterMs: 48 * HOUR, dated: true },
      { id: `followed-back:b2:${NOW - 3 * HOUR}`, at: NOW - 3 * HOUR, kind: 'followed-back', person: { pk: 'b2', username: null },
        afterMs: null, dated: false },
      { id: `new-follower:n1:${NOW - 5 * HOUR}`, at: NOW - 5 * HOUR, kind: 'new-followers', people: [{ pk: 'n1', username: 'nina' }],
        dated: true },
    ]);
    expect(r.calls.fresh).toEqual(['own', NOW - 6 * HOUR + 1, LIVE.FEED_LIMIT * LIVE.GROUP_PEOPLE_MAX]);
  });

  test('before the followers baseline exists nothing is news; lost followers read as a count per check', () => {
    const r = reads({ fresh: [{ pk: 'n1', username: null, at: NOW - HOUR, dated: false }],
      lost: [{ at: NOW - 2 * HOUR, count: 3 }] });
    const view = shapeFeed(r, ctx({ baselineAt: null }));
    expect(r.calls.fresh).toBeUndefined();
    expect(view.items).toEqual([{ id: `lost:${NOW - 2 * HOUR}`, at: NOW - 2 * HOUR, kind: 'lost-followers', count: 3 }]);
  });
});

test('runtime, recovery, catch-up and kept moments join the feed; session rows never do', () => {
  const away = { awayFrom: NOW - 20 * HOUR, checkedAt: NOW - 4 * HOUR, newFollowers: 3, followBacks: 1, left: 0 };
  const view = shapeFeed(reads({}), ctx({
    incidents: [{ at: NOW - HOUR, reason: 'process-recovery-start' }, { at: NOW - 30 * MIN, reason: 'intentional-shutdown' }],
    recoveryIncident: { at: NOW - 2 * HOUR, resumeAt: NOW + HOUR },
    away, awayFrom: away.awayFrom,
    kept: [{ pk: 'k1', username: 'friend', reason: 'account', keptAt: NOW - 3 * HOUR }],
  }));
  expect(view.items).toEqual([
    { id: `resumed:${NOW - HOUR}`, at: NOW - HOUR, kind: 'resumed', after: 'restart' },
    { id: `slowed:${NOW - 2 * HOUR}`, at: NOW - 2 * HOUR, kind: 'slowed-down', until: NOW + HOUR },
    { id: `kept:k1:${NOW - 3 * HOUR}`, at: NOW - 3 * HOUR, kind: 'kept', person: { pk: 'k1', username: 'friend' }, reason: 'account' },
    { id: `caught-up:${NOW - 4 * HOUR}`, at: NOW - 4 * HOUR, kind: 'caught-up', summary: away },
  ]);
  expect(view.awayFrom).toBe(away.awayFrom);
});

describe('the window', () => {
  test('whole plan-days: today and the ones that began inside the window, today first', () => {
    const days = feedDays(utcDays, NOW);
    const today = utcDays.window(NOW);
    expect(days[0]).toEqual({ key: today.key, startsAt: today.startsAt });
    expect(days).toHaveLength(LIVE.FEED_WINDOW_MS / DAY);
    expect(days.every((d, i) => i === 0 || d.startsAt === days[i - 1].startsAt - DAY)).toBe(true);
    expect(days[days.length - 1].startsAt).toBeGreaterThanOrEqual(NOW - LIVE.FEED_WINDOW_MS);
  });

  test('rows before the first day are not read and not shown; the view carries the days', () => {
    const r = reads({ effects: [effect(1), effect(9 * 24 * 60)] });
    const view = shapeFeed(r, ctx());
    const start = feedDays(utcDays, NOW).at(-1)?.startsAt;
    expect(view).toMatchObject({ windowStart: start, shapedAt: NOW, days: feedDays(utcDays, NOW) });
    expect(view.items.map((i) => i.id)).toEqual(['effect:i1']);
    expect(r.calls.effects).toEqual([start, LIVE.FEED_LIMIT * LIVE.GROUP_PEOPLE_MAX]);
  });

  test('a source cut at its read limit cuts every older row, so no gap reads as quiet', () => {
    const limit = LIVE.FEED_LIMIT * LIVE.GROUP_PEOPLE_MAX;
    const effects = Array.from({ length: limit }, (_, i) => effect(i, { settledAt: NOW - i * MIN, action: i % 2 ? 'unfollow' : 'follow' }));
    const view = shapeFeed(reads({ effects, lost: [{ at: NOW - (limit + 5) * MIN, count: 1 }] }), ctx());
    expect(view.items.some((i) => i.kind === 'lost-followers')).toBe(false);
    expect(view.items).toHaveLength(LIVE.FEED_LIMIT);
  });
});

test('the not-built feed is empty and says so', () => {
  expect(notBuiltFeed(NOW)).toEqual({ items: [], awayFrom: null, windowStart: NOW, shapedAt: NOW });
});

describe('L-FEED', () => {
  const minuteAgo = fc.integer({ min: 0, max: 10 * 24 * 60 });
  const arbEffect = fc.record({
    ago: minuteAgo,
    action: fc.constantFrom('follow', 'unfollow', 'accept') as fc.Arbitrary<EffectFeedRow['action']>,
    channel: fc.constantFrom('growth', 'prune', 'manual') as fc.Arbitrary<EffectFeedRow['channel']>,
    result: fc.constantFrom('ok', 'simulated', 'fail', 'expired') as fc.Arbitrary<EffectFeedRow['result']>,
  });
  interface Follower { ago: number; pk: number; dated: boolean }
  interface Generated {
    effects: { ago: number; action: EffectFeedRow['action']; channel: EffectFeedRow['channel']; result: EffectFeedRow['result'] }[];
    backs: Follower[];
    fresh: Follower[];
    lost: { ago: number; count: number }[];
  }
  const arbFollower = (maxPk: number): fc.Arbitrary<Follower> =>
    fc.record({ ago: minuteAgo, pk: fc.integer({ min: 0, max: maxPk }), dated: fc.boolean() });
  const arbRows: fc.Arbitrary<Generated> = fc.record({
    effects: fc.array(arbEffect, { maxLength: 150 }),
    backs: fc.array(arbFollower(40), { maxLength: 40 }),
    fresh: fc.array(arbFollower(80), { maxLength: 120 }),
    lost: fc.array(fc.record({ ago: minuteAgo, count: fc.integer({ min: 1, max: 9 }) }), { maxLength: 10 }),
  });
  const build = (g: Generated): { rows: Rows; atOf: Map<string, number> } => {
    const atOf = new Map<string, number>();
    const effects = g.effects.map((e, n) => {
      atOf.set(`e${n}`, NOW - e.ago * MIN);
      return effect(n, { pk: `e${n}`, settledAt: NOW - e.ago * MIN, action: e.action, channel: e.action === 'accept' ? 'accept-request' : e.channel, result: e.result });
    });
    const uniq = <T, K>(list: readonly T[], key: (r: T) => K): T[] => [...new Map(list.map((r): [K, T] => [key(r), r])).values()];
    const backs = uniq(g.backs, (b) => b.pk)
      .map((b) => ({ pk: `f${b.pk}`, username: null, at: NOW - b.ago * MIN, dated: b.dated, followedAt: null }));
    const fresh = uniq(g.fresh, (f) => f.pk).map((f) => {
      atOf.set(`f${f.pk}`, NOW - f.ago * MIN);
      return { pk: `f${f.pk}`, username: null, at: NOW - f.ago * MIN, dated: f.dated };
    });
    const lost = uniq(g.lost, (l) => l.ago).map((l) => ({ at: NOW - l.ago * MIN, count: l.count }));
    return { rows: { effects, backs, fresh, lost }, atOf };
  };

  test('unique ids, newest first, inside the window, at most the limit, groups within one boundary', () => {
    fc.assert(fc.property(arbRows, (g) => {
      const { rows, atOf } = build(g);
      const view = shapeFeed(reads(rows), ctx({ baselineAt: NOW - 20 * DAY }));
      const ids = view.items.map((i) => i.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(view.items.every((it, i) => i === 0 || view.items[i - 1].at >= it.at)).toBe(true);
      expect(view.items.every((it) => it.at >= view.windowStart)).toBe(true);
      expect(view.items.length).toBeLessThanOrEqual(LIVE.FEED_LIMIT);
      const backPks = new Set(view.items.flatMap((i) => (i.kind === 'followed-back' ? [i.person.pk] : [])));
      for (const item of view.items) {
        if (item.kind !== 'followed' && item.kind !== 'unfollowed' && item.kind !== 'new-followers') continue;
        const ats = item.people.map((p) => atOf.get(p.pk) as number);
        expect(Math.max(...ats) - Math.min(...ats)).toBeLessThanOrEqual(LIVE.GROUP_WINDOW_MS);
        expect(item.people.length).toBeLessThanOrEqual(LIVE.GROUP_PEOPLE_MAX);
        if (item.kind === 'new-followers') for (const p of item.people) expect(backPks.has(p.pk)).toBe(false);
      }
    }), { numRuns: 150 });
  });

  test('a newer row never renames an existing group', () => {
    fc.assert(fc.property(arbRows, arbEffect, (g, extra) => {
      const { rows } = build({ effects: g.effects.slice(0, 25), backs: g.backs.slice(0, 10), fresh: g.fresh.slice(0, 10),
        lost: g.lost.slice(0, 5) });
      const before = shapeFeed(reads(rows), ctx()).items.map((i) => i.id);
      const newest = effect(9_999, { pk: 'x', settledAt: NOW + MIN, action: extra.action === 'accept' ? 'follow' : extra.action });
      const after = new Set(shapeFeed(reads({ ...rows, effects: [newest, ...(rows.effects ?? [])] }), ctx()).items.map((i) => i.id));
      expect(before.filter((id) => !after.has(id))).toEqual([]);
    }), { numRuns: 150 });
  });
});
