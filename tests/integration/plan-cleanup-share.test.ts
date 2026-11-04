/** The live Advanced and migrated cleanup shares must reach the plan and its re-plan fingerprint. */
import { PlanService } from '@/governors/plan-service';
import { PREFERENCES } from '@/kernel/policy';
import { SettingsService } from '@/main/modules/settings-service';
import { SETTINGS_FILES } from '@/settings/persist';
import { intentDigest, toPlanIntent } from '@/settings/plan-intent';
import { emptyDemand, memoryPlanStore, planDeps } from '../kit/plan';
import { memoryFs } from '../kit/settings';

const FROM = new Date(2026, 10, 3, 12).getTime();
const LOWER = 0.1;
const NORMALIZED_LOWER = LOWER / PREFERENCES.cleanup.deep.fraction;

function settings(file?: string) {
  const fs = memoryFs(file === undefined ? {} : { [SETTINGS_FILES.v1]: file });
  return new SettingsService({ userDataDir: '/u', fs: fs.fs, knowledgeDbExists: () => false,
    now: () => FROM, push: () => {} });
}

test('lowering the live Advanced cleanup share changes the digest and re-plans less cleanup', () => {
  const s = settings();
  expect(s.apply([
    { op: 'intent', key: 'cleanup', value: 'steady' },
    { op: 'intent', key: 'quietHours', value: { kind: 'none' } },
    { op: 'override', key: 'pace.restDayChance', value: 0 },
  ], 'user').kind).toBe('saved');
  const store = memoryPlanStore();
  const clock = { t: FROM };
  const plan = new PlanService(planDeps(store, clock, { intent: () => toPlanIntent(s.effective()),
    demand: () => emptyDemand({ pruneStock: 1_000 }) }));
  clock.t = plan.view(clock.t).window.startsAt;
  const before = plan.ensure(clock.t).plan;
  expect(before.kinds.unfollow).toBeGreaterThan(0);
  const digest = intentDigest(toPlanIntent(s.effective()));
  s.onChange(() => plan.onSettings(clock.t));

  expect(s.apply([{ op: 'override', key: 'unfollow.cleanupShare', value: LOWER }], 'user').kind).toBe('saved');
  expect(s.effective().maxUnfollowFractionPerSession).toBe(LOWER);
  const intent = toPlanIntent(s.effective());
  expect(intent.cleanupShare).toBeCloseTo(NORMALIZED_LOWER, 12);
  expect(intentDigest(intent)).not.toBe(digest);
  const after = plan.view(clock.t).plan;
  expect(after.cause).toBe('settings');
  expect(after.intentDigest).toBe(intentDigest(intent));
  expect(after.volume.planned).toBe(before.volume.planned);
  expect(after.kinds.unfollow).toBeLessThan(before.kinds.unfollow);
  expect(after.sessions.reduce((n, session) => n + session.mix.unfollow, 0)).toBe(after.kinds.unfollow);

  s.apply([{ op: 'clear-override', key: 'unfollow.cleanupShare' }], 'user');
  expect(intentDigest(toPlanIntent(s.effective()))).toBe(digest);
  expect(plan.view(clock.t).plan.kinds.unfollow).toBe(before.kinds.unfollow);
});

test('a migrated custom cleanup share keeps its lower plan allocation', () => {
  const s = settings(JSON.stringify({ pruneScheduleDays: 7, weaveEnabled: true, maxUnfollowFractionPerSession: LOWER }));
  expect(s.view().health.kind).toBe('migrated');
  expect(s.effective().maxUnfollowFractionPerSession).toBe(LOWER);
  expect(toPlanIntent(s.effective()).cleanupShare).toBeCloseTo(NORMALIZED_LOWER, 12);
  s.apply([{ op: 'intent', key: 'cleanup', value: 'off' }], 'user');
  expect(toPlanIntent(s.effective()).cleanupShare).toBe(0);
});
