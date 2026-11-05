/** Unfollows spend their own session allocation; follows and accepts cannot consume it indirectly. */
import { PlanService } from '@/governors/plan-service';
import { viewPlan } from '@/governors/plan-view';
import { drawBase, replanRemainder } from '@/kernel/plan/draw';
import { drawInput, emptyDemand, memoryPlanStore, noUse, planDeps, testIntent, viewInputs } from '../kit/plan';

const at = new Date(2026, 10, 3, 12).getTime();
const intent = testIntent({ cleanupShare: 0.71, acceptRequests: false });
const demand = emptyDemand({ lifecycleDueByDayEnd: 4, pruneStock: 80 });
const plan = drawBase(drawInput(at, { intent, demand }));
const idx = plan.sessions.findIndex((s) => s.mix.unfollow > 0 && s.mix.follow > 0);
const s = plan.sessions[idx];

test.each(['growth', 'woven', 'cleanup-run'] as const)('%s refuses the first unfollow beyond the session share', (writer) => {
  const used = noUse({ auto: s.mix.unfollow, all: s.mix.unfollow, unfollow: s.mix.unfollow,
    perSession: plan.sessions.map((_, i) => i === idx ? s.mix.unfollow : 0),
    perSessionKinds: plan.sessions.map((_, i) => ({ follow: 0, unfollow: i === idx ? s.mix.unfollow : 0, accept: 0 })) });
  const v = viewPlan(plan, viewInputs(plan, s.startAt, { intent, used }));
  expect(used.unfollow).toBeLessThan(plan.kinds.unfollow);
  expect(v.admits('unfollow', writer)).toMatchObject({ ok: false, reason: 'kind-spent' });
  expect(v.admits('follow', 'growth')).toEqual({ ok: true });
  expect(v.admits('unfollow', 'manual')).toEqual({ ok: true });
});

test('real ledger kind tallies preserve the unfollow share after follows spend their own allocation', () => {
  const store = memoryPlanStore();
  const clock = { t: at };
  const service = new PlanService(planDeps(store, clock, { intent: () => intent, demand: () => demand }));
  for (let n = 0; n < s.mix.follow; n += 1) store.mutations.push({ at: s.startAt, kind: 'follow', auto: true });
  const used = service.usage(plan, s.startAt);
  expect(used.perSessionKinds?.[idx]).toEqual({ follow: s.mix.follow, unfollow: 0, accept: 0 });
  const v = viewPlan(plan, viewInputs(plan, s.startAt, { intent, used, joinedAt: used.joinedAt }));
  expect(v.open?.mixLeft.unfollow).toBe(s.mix.unfollow);
  expect(v.admits('unfollow', 'cleanup-run')).toEqual({ ok: true });
});

test('lowering the target below actual usage reports the ledger and admits no more automatic writes', () => {
  const input = drawInput(at);
  const before = drawBase(input);
  const now = before.sessions[1].startAt;
  const used = noUse({ auto: 20, all: 20, follow: 20, perSession: [20] });
  const loweredIntent = testIntent({ operatingRate: 15 });
  const lowered = replanRemainder(before, { ...input, intent: loweredIntent }, now, used, 'settings');
  const v = viewPlan(lowered, viewInputs(lowered, now, { intent: loweredIntent, used }));
  expect(v.used.auto).toBe(20);
  expect(v.remaining).toBe(0);
  expect(v.admits('follow', 'growth')).toMatchObject({ ok: false, reason: 'day-done' });
});
