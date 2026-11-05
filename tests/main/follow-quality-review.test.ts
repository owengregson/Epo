import { ActionDeferredError } from '@/adapter/errors';
import { FollowbackWatcher } from '@/engine/followback-watcher';
import { UNCONFIGURED_PROTECTION } from '@/engine/protection-port';
import { SourceFrontier } from '@/engine/source-frontier';
import { ReadBudget } from '@/governors/read-budget';
import { createMutationPolicy } from '@/main/services/mutation-policy';
import type { ProfileVisit } from '@/rim/profile-visit-port';
import { effectiveFromV1 } from '@/settings/effective';
import { toScorerConfig } from '@/settings/mappers';
import { DEFAULT_SETTINGS, type Settings } from '@/settings/settings';
import type { FollowRecord } from '@/store/types';
import { type SessionPlanRig, sessionPlanRig } from '../kit/harness-plan';
import { readLimits } from '../kit/read-limits';

let rig: SessionPlanRig;
let settings: Settings;
let following: number;
let floor: number;
let visit: jest.Mock<Promise<ProfileVisit>, [string]>;
let validateFollow: jest.Mock<boolean, [FollowRecord]>;

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, dryRun: false };
  rig = sessionPlanRig(settings);
  following = 550;
  floor = 0.9;
  validateFollow = jest.fn((record) => (record.score ?? 0) >= floor);
  rig.store.upsertFollowRecord({ accountPk: 'a', targetPk: 'seed', state: 'queued', retryCount: 0, score: 2.5 });
  visit = jest.fn(async (username): Promise<ProfileVisit> => {
    const obs = { accountPk: 'a', observedAt: rig.clock.now(), source: 'profile' as const,
      fields: { username, followers: 500, following, isPrivate: false, isVerified: false } };
    rig.store.observe(obs);
    return { ok: true, tier: 'canonical', partial: false, obs,
      viewer: { following: false, requested: false, followsUs: false } };
  });
});
afterEach(() => rig.dispose());

const policy = () => createMutationPolicy({
  store: rig.store, ownPk: 'me', clock: rig.clock, cadence: rig.plan.cadence,
  readBudget: new ReadBudget({ store: rig.store, clock: rig.clock, limits: readLimits() }),
  profiles: () => ({ visit }), settings: () => effectiveFromV1(settings),
  protection: () => UNCONFIGURED_PROTECTION, signal: () => undefined, validateFollow,
  followback: () => new FollowbackWatcher({ store: rig.store, clock: rig.clock, ownPk: 'me',
    cfg: { holdAfterFollowbackMs: 0, autoAcceptRequests: false } }),
});

test('a fresh eligible score below the cohort floor stays positive and queued without dispatch', async () => {
  following = 450;
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({ reason: 'source-quality' });
  expect(validateFollow).toHaveBeenCalledWith(expect.objectContaining({ score: 0.6 }));
  expect(rig.store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 0.6, retryCount: 0 });
  expect(rig.store.getActionDelayDeadline()).toBeNull();
  expect(rig.store.actionCountSince(0)).toBe(0);
  expect(visit).toHaveBeenCalledTimes(1);
});

test('quality changes after review are checked before the first dispatch deadline is armed', async () => {
  const p = policy();
  await p.prepareProfile('alice', 'a', 'follow');
  floor = 1.1;
  await expect(p.beforeMutation()).rejects.toMatchObject({ reason: 'source-quality' });
  expect(rig.store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 1 });
  expect(rig.store.getActionDelayDeadline()).toBeNull();
  expect(visit).toHaveBeenCalledTimes(1);
});

test('the same action guard rechecks quality for later presses without another visit or deadline', async () => {
  const p = policy();
  const guard = await p.prepareProfile('alice', 'a', 'follow');
  await p.beforeMutation();
  const deadline = rig.store.getActionDelayDeadline();
  expect(deadline).toBeGreaterThan(rig.clock.now());
  floor = 1.1;
  expect(guard).toThrow(ActionDeferredError);
  expect(rig.store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 1 });
  expect(rig.store.getActionDelayDeadline()).toBe(deadline);
  expect(visit).toHaveBeenCalledTimes(1);
});

test('a settings edit between review and dispatch still enforces hard eligibility', async () => {
  const p = policy();
  await p.prepareProfile('alice', 'a', 'follow');
  settings = { ...settings, minFollowers: 1_000 };
  await expect(p.beforeMutation()).rejects.toThrow('no longer eligible');
  expect(rig.store.getFollowRecord('a')).toMatchObject({ state: 'queued', score: 0 });
  expect(rig.store.getActionDelayDeadline()).toBeNull();
});

test('an explicit manual follow keeps its existing eligibility rules without automatic source-quality policy', async () => {
  floor = 10;
  rig.store.beginEffectIntent({ accountPk: 'a', username: 'alice', action: 'follow', channel: 'manual', at: rig.clock.now() });
  const p = policy();
  const guard = await p.prepareProfile('alice', 'a', 'follow');
  await p.beforeMutation();
  expect(guard).not.toThrow();
  expect(validateFollow).not.toHaveBeenCalled();
  expect(visit).toHaveBeenCalledTimes(1);
});

test('quality checks cannot replace the existing fresh-count evidence requirement', async () => {
  visit.mockResolvedValue({ ok: true, tier: 'canonical', partial: false,
    obs: { accountPk: 'a', observedAt: rig.clock.now(), source: 'profile', fields: { username: 'alice' } },
    viewer: { following: false, requested: false, followsUs: false } });
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({
    verdict: { kind: 'unavailable', evidence: 'unreadable' },
  });
  expect(validateFollow).not.toHaveBeenCalled();
  expect(rig.store.getFollowRecord('a')?.score).toBe(2.5);
});

test('the real durable cohort rejects a fresh downgrade without lowering its anchored expectation', async () => {
  rig.store.addTarget({ accountPk: 'seed', source: 'seed', status: 'active', chainIndex: 0 });
  for (const pk of ['a', 'b']) {
    rig.store.observe({ accountPk: pk, source: 'profile', observedAt: rig.clock.now() - 1,
      fields: { username: pk, followers: 500, following: 550, isPrivate: false, isVerified: false } });
    rig.store.upsertFollowRecord({ accountPk: pk, targetPk: 'seed', state: 'queued', retryCount: 0, score: 1 });
  }
  const frontier = new SourceFrontier({ store: rig.store, clock: rig.clock, quality: {
    scorer: () => toScorerConfig(effectiveFromV1(settings)), readyCount: () => 2, capacity: () => 10,
  } });
  frontier.refreshQuality();
  expect(frontier.qualityView()).toMatchObject({ floor: 1, qualifiedSources: ['seed'] });
  validateFollow.mockImplementation((record) => frontier.allowsFollow(record));
  following = 450;
  await expect(policy().prepareProfile('alice', 'a', 'follow')).rejects.toMatchObject({ reason: 'source-quality' });
  expect(rig.store.getFollowRecord('a')).toMatchObject({ score: 0.6, state: 'queued' });
  expect(frontier.qualityView().floor).toBe(1);
  expect(rig.store.getActionDelayDeadline()).toBeNull();
});
