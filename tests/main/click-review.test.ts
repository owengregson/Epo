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
import { DEFAULT_SETTINGS } from '@/settings/settings';
import type { PausedActivity } from '@/shared/surface-gate';
import { compileProtection } from '@/shared/unfollow-protection';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
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
  store, ownPk: 'me', clock, readBudget: budget, profiles: () => ({ visit }), settings: () => DEFAULT_SETTINGS,
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
