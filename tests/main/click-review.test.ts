/**
 * The click review's Phase F seams (F2a step 9): the plan's preflight and the
 * surface gate run BEFORE the visit, so a refusal spends no read. Their
 * defaults admit and never pause, so today's review runs unchanged.
 */
import { ActionDeferredError, ActionReviewedError } from '@/adapter/errors';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { FakeClock } from '@/governors/clock';
import type { Admission } from '@/governors/plan-types';
import { ReadBudget } from '@/governors/read-budget';
import { type ClickReviewDeps, createClickReview } from '@/main/services/click-review';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { effectiveFromV1 } from '@/settings/effective';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { PausedActivity } from '@/shared/surface-gate';
import { compileProtection } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { FollowRecord, Observation } from '@/store/types';
import { readLimits } from '../kit/read-limits';
import { openTestStore } from '../kit/store';

let store: KnowledgeStore;
let clock: FakeClock;
let budget: ReadBudget;
let visit: jest.Mock<Promise<ProfileVisit>, [string]>;

beforeEach(() => {
  store = openTestStore(':memory:');
  clock = new FakeClock(Date.UTC(2026, 10, 3, 12));
  budget = new ReadBudget({ store, clock, limits: readLimits() });
  visit = jest.fn(async (username: string): Promise<ProfileVisit> => ({
    ok: true,
    obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username } },
    viewer: { following: true, requested: false, followsUs: false },
  }));
});
afterEach(() => store.close());

const review = (over: Partial<ClickReviewDeps> = {}) => createClickReview({
  store, ownPk: 'me', clock, readBudget: budget, profiles: () => ({ visit }), settings: () => effectiveFromV1(DEFAULT_SETTINGS),
  protection: () => UNCONFIGURED_PROTECTION, signal: () => undefined, active: async () => true, ...over,
});
const profileReads = (): number => budget.snapshot().debits.filter((d) => d.kind === 'profile').length;

test('with the default seams the review runs as today: one read, one visit', async () => {
  await expect(review().prepareProfile('alice', 'a', 'follow')).resolves.toBeUndefined();
  expect(visit).toHaveBeenCalledTimes(1);
  expect(profileReads()).toBe(1);
});

test('a refusing preflight defers with its reason and until, before any read or visit', async () => {
  const calls: unknown[][] = [];
  const preflight = (...args: unknown[]): Admission => {
    calls.push(args);
    return { ok: false, reason: 'hourly-cap', until: 5_000 };
  };
  const err = await review({ preflight }).prepareProfile('alice', 'a', 'unfollow').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ActionDeferredError);
  expect(err).toMatchObject({ reason: 'hourly-cap', until: 5_000 });
  expect(calls).toEqual([['unfollow', 'growth', clock.now(), { pk: 'a' }]]);
  expect(visit).not.toHaveBeenCalled();
  expect(profileReads()).toBe(0);
});

test('the preflight hears which loop asks', async () => {
  const writers: unknown[] = [];
  const preflight = (_k: unknown, writer: unknown): Admission => { writers.push(writer); return { ok: true }; };
  await review({ preflight, writer: () => 'cleanup-run' }).prepareProfile('alice', 'a', 'follow');
  expect(writers).toEqual(['cleanup-run']);
  expect(visit).toHaveBeenCalledTimes(1);
});

describe('a fresh follow requires complete declared profile evidence', () => {
  const presence = { counts: 'read', bio: 'read', isPrivate: 'read', isVerified: 'read', relationship: 'read' } as const;
  const queue = (): void => {
    store.observe({ accountPk: 'a', observedAt: clock.now() - 1, source: 'profile',
      fields: { username: 'alice', followers: 500, following: 550, isPrivate: false } });
    store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'queued', score: 10, retryCount: 0 });
  };
  test.each([
    { tier: 'recovered' as const, partial: false, counts: 'read' as const },
    { tier: 'canonical' as const, partial: true, counts: 'read' as const },
    { tier: 'normalized' as const, partial: true, counts: 'read' as const },
    { tier: 'canonical' as const, partial: false, counts: 'absent' as const },
    { tier: 'canonical' as const, partial: false, counts: 'partial' as const },
    { tier: 'canonical' as const, partial: false, counts: 'invalid' as const },
  ])('$tier partial=$partial counts=$counts cannot reuse stored eligibility', async ({ tier, partial, counts }) => {
    queue();
    visit.mockResolvedValue({ ok: true, tier, partial, presence: { ...presence, counts },
      obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username: 'alice' } },
      viewer: { following: null, requested: null, followsUs: null } });
    await expect(review().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({
      verdict: { kind: 'unavailable', evidence: 'unreadable' },
    });
    expect(visit).toHaveBeenCalledTimes(1);
    expect(profileReads()).toBe(1);
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 10 });
  });
  test.each(['canonical', 'normalized'] as const)('complete %s evidence still permits the follow', async (tier) => {
    queue();
    visit.mockResolvedValue({ ok: true, tier, partial: false, presence,
      obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile',
        fields: { username: 'alice', followers: 500, following: 550, isPrivate: false } },
      viewer: { following: false, requested: false, followsUs: false } });
    await expect(review().prepareProfile('alice', 'a', 'follow')).resolves.toBeUndefined();
  });
  test('missing fresh counts cannot authorize a queued follow even without parser metadata', async () => {
    queue();
    await expect(review().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({
      verdict: { kind: 'unavailable', evidence: 'unreadable' },
    });
    expect(store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 10 });
  });
});

test('a surface gate pausing unfollows defers an unfollow before any read; a follow still proceeds', async () => {
  const asked: PausedActivity[] = [];
  const surfaceGate = { paused: (a: PausedActivity) => { asked.push(a); return a === 'unfollows'; } };
  const err = await review({ surfaceGate }).prepareProfile('alice', 'a', 'unfollow').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ActionDeferredError);
  expect(err).toMatchObject({ reason: 'surface-paused', until: null });
  expect(visit).not.toHaveBeenCalled();
  expect(profileReads()).toBe(0);
  await review({ surfaceGate }).prepareProfile('alice', 'a', 'follow');
  expect(visit).toHaveBeenCalledTimes(1);
  expect(asked).toEqual(['unfollows']);
});

describe('step 5–6: protection on the fresh fields, then sources (spec §7.4, §9.7)', () => {
  const words = (...ws: string[]) => compileProtection({ accounts: [], words: ws.map((text) => ({ text, addedAt: 0 })),
    wordMatch: 'anywhere', keepVerified: true }, 'ready', 1);
  const seen = (fields: Observation['fields'], followsUs: boolean | null = false): void => {
    visit.mockImplementation(async () => ({
      ok: true, obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile', fields: { username: 'alice', ...fields } },
      viewer: { following: true, requested: false, followsUs },
    }));
  };
  const verdictOf = async (r: ReturnType<typeof review>, action: 'follow' | 'unfollow' = 'unfollow') => {
    const e = await r.prepareProfile('alice', 'a', action).then(() => null, (x: unknown) => x);
    return e instanceof ActionReviewedError ? e.verdict : e;
  };

  test('a paused index refuses every unfollow before any read; follows go on', async () => {
    const paused = compileProtection({ accounts: [], words: [], wordMatch: 'anywhere', keepVerified: false }, 'needs-review', 1);
    expect(await verdictOf(review({ protection: () => paused }))).toEqual({ kind: 'protection-paused', state: 'needs-review' });
    expect(visit).not.toHaveBeenCalled();
    expect(profileReads()).toBe(0);
    expect(await verdictOf(review({ protection: () => paused }), 'follow')).toBeNull();
  });

  test('a stored bio that matches never stands in for a fresh body without biography: unknown, never unfollowed', async () => {
    store.observe({ accountPk: 'a', observedAt: clock.now() - 1, source: 'profile', fields: { bio: 'my cafe' } });
    seen({ isVerified: false });
    expect(await verdictOf(review({ protection: () => words('cafe') }))).toEqual({ kind: 'protection-unknown', missing: 'bio' });
  });

  test('a stored old bio that does not match loses to a fresh one that does', async () => {
    store.observe({ accountPk: 'a', observedAt: clock.now() - 1, source: 'profile', fields: { bio: 'photographer' } });
    seen({ bio: 'now running a cafe', isVerified: false });
    expect(await verdictOf(review({ protection: () => words('cafe') })))
      .toEqual({ kind: 'protected', by: 'bio-word', match: 'cafe' });
  });

  test('protection comes before the follow-back logic: a protected mutual is kept, not re-held', async () => {
    seen({ bio: 'x', isVerified: true }, true);
    expect(await verdictOf(review({ protection: () => words('cafe') }))).toEqual({ kind: 'protected', by: 'verified', match: 'verified' });
    expect(store.getFollowRecord('a')).toBeNull();
  });

  test('a source is protected as a consuming verdict, not a looping deferral', async () => {
    seen({ bio: 'x', isVerified: false });
    store.addTarget({ accountPk: 'a', source: 'seed', status: 'active', chainIndex: 0 });
    expect(await verdictOf(review({ protection: () => words('cafe') }))).toEqual({ kind: 'protected', by: 'source', match: 'a' });
  });

  test('clear goes on to the relationship review: a confirmed non-follower proceeds', async () => {
    seen({ bio: 'photographer', isVerified: false }, false);
    expect(await verdictOf(review({ protection: () => words('cafe') }))).toBeNull();
  });
});

describe('the full click order (spec §9.7)', () => {
  const v0 = { following: true, requested: false, followsUs: false };
  const page = (viewer: object, over: Partial<Observation> = {}) => visit.mockImplementation(async (username) => ({
    ok: true as const, viewer: viewer as typeof v0,
    obs: { accountPk: 'a', observedAt: clock.now(), source: 'profile' as const, fields: { username }, ...over },
  }));
  const outcome = async (action: 'follow' | 'unfollow' = 'unfollow', over: Partial<ClickReviewDeps> = {}) => {
    const e = await review(over).prepareProfile('alice', 'a', action).then(() => null, (x: unknown) => x);
    if (e instanceof ActionReviewedError) return e.verdict;
    if (e instanceof ActionDeferredError) return { deferred: e.reason, until: e.until };
    return e;
  };
  const queued = (over: Partial<FollowRecord> = {}) => store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed',
    state: 'unfollow_queued', retryCount: 0, followedAt: clock.now() - 9 * 86_400_000, ...over });

  test('0a: an unsettled write to this account defers before any read; another account\'s never does', async () => {
    const other = store.beginEffectIntent({ accountPk: 'b', username: 'bob', action: 'unfollow', channel: 'growth', at: 1 });
    store.markEffectUncertain(other.id, 2);
    expect(await outcome()).toBeNull();
    const own = store.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'manual', at: 3 });
    store.markEffectDispatched(own.id, 4);
    visit.mockClear();
    expect(await outcome()).toEqual({ deferred: 'journal', until: null });
    expect(visit).not.toHaveBeenCalled();
  });

  test('0c: a refused read defers until the allowance reopens, with no visit', async () => {
    const refusing = { consume: () => ({ allowed: false, resumeAt: 9_000 }) } as unknown as ReadBudget;
    expect(await outcome('unfollow', { readBudget: refusing })).toEqual({ deferred: 'read-budget', until: 9_000 });
    expect(visit).not.toHaveBeenCalled();
  });

  test('1–4: gone, unanswered, a wall, another pk and a stale body', async () => {
    visit.mockResolvedValueOnce({ ok: false, kind: 'gone', detail: {} });
    expect(await outcome()).toEqual({ kind: 'unavailable', evidence: 'absent' });
    visit.mockResolvedValueOnce({ ok: false, kind: 'unanswered', detail: {} });
    expect(await outcome('follow')).toEqual({ kind: 'unavailable', evidence: 'unreadable' });
    visit.mockResolvedValueOnce({ ok: false, kind: 'walled', detail: {} });
    expect(await outcome()).toEqual({ deferred: 'walled', until: null });
    page(v0, { accountPk: 'someone-else' });
    expect(await outcome()).toEqual({ kind: 'unavailable', evidence: 'renamed' });
    page(v0, { observedAt: clock.now() - 1 });
    expect(await outcome()).toEqual({ kind: 'unavailable', evidence: 'unreadable' });
    expect(store.getEdge('a', 'me', 'follows')).toBeNull();
  });

  test('7: a fresh incoming request without a stored edge is request-pending, and records the request', async () => {
    page({ ...v0, incomingRequest: true });
    expect(await outcome()).toEqual({ kind: 'request-pending' });
    expect(store.getEdge('a', 'me', 'requests')?.status).toBe('active');
  });

  test('7: an open request edge is request-pending though the fresh body says nothing about it', async () => {
    store.observeEdge('a', 'me', 'requests', true, clock.now() - 1);
    page(v0);
    expect(await outcome()).toEqual({ kind: 'request-pending' });
  });

  test('8–9: no longer followed is already-gone; an unread follows-us flag is unreadable', async () => {
    page({ following: false, requested: false, followsUs: false });
    expect(await outcome()).toEqual({ kind: 'already-gone' });
    page({ ...v0, followsUs: null });
    expect(await outcome()).toEqual({ kind: 'unavailable', evidence: 'unreadable' });
  });

  test('10: a confirmed non-follower proceeds and the record is stamped reconciled', async () => {
    queued();
    page(v0);
    expect(await outcome()).toBeNull();
    expect(store.getFollowRecord('a')?.reconciledAt).toBe(clock.now());
  });

  test('11–13: a mutual with no follow-back evidence is re-held; one still on hold is not due; a due one proceeds', async () => {
    page({ ...v0, followsUs: true });
    queued();
    expect(await outcome()).toEqual({ kind: 'reheld' });
    expect(store.getFollowRecord('a')?.state).toBe('unfollow_queued');
    queued({ followbackObservedAt: clock.now() - 5, holdUntil: clock.now() + 1_000 });
    expect(await outcome()).toEqual({ kind: 'not-due' });
    queued({ followbackObservedAt: clock.now() - 5, holdUntil: clock.now() - 1 });
    expect(await outcome()).toBeNull();
    store.upsertFollowRecord({ accountPk: 'a', targetPk: null, state: 'external', retryCount: 0 });
    expect(await outcome()).toEqual({ kind: 'not-due' });
  });
});
