import { KnowledgeStore } from '@/store/knowledge-store';
import { Scanner } from '@/engine/scanner';
import { ChurnScheduler, CHURN_DEFAULTS } from '@/engine/churn-scheduler';
import { RateGovernor } from '@/governors/rate-governor';
import { FakeClock } from '@/governors/clock';

test('E2E: Scanner ranking → persisted score → nextDue picks the best candidate', async () => {
  const store = new KnowledgeStore(':memory:');
  const clock = new FakeClock(1_000_000);
  store.setOwnPk('me');

  // Three followers of target T. 'aaa' has the LOWEST pk but mediocre stats;
  // 'zzz' has the highest pk and many mutuals → must be followed FIRST.
  const mk = (pk: string, followers: number, following: number, mutuals: number) => {
    store.observe({
      accountPk: pk, observedAt: 1_000, source: 'profile',
      fields: { username: 'u' + pk, followers, following, mutuals },
    });
    store.observeEdge(pk, 'T', 'follows', true, 1_000);
  };
  mk('aaa', 1000, 1050, 0);   // near 1:1, no mutuals  (the reported bad pick)
  mk('mmm', 1000, 1100, 3);
  mk('zzz', 1000, 1100, 20);  // capped mutuals → best

  new Scanner({ store }).planTarget('T');

  const scored = ['aaa', 'mmm', 'zzz'].map((pk) => store.getFollowRecord(pk)!.score!);
  expect(scored.every((s) => typeof s === 'number')).toBe(true);

  const sched = new ChurnScheduler({
    store, clock,
    rate: new RateGovernor(store, clock, {
      dailyHardCeiling: 100, dailyOperatingRate: 100, minDelayMs: 0, maxDelayMs: 0,
      jitterPercent: 0, activeHoursStart: 0, activeHoursEnd: 24,
    }),
    actions: { follow: async () => ({ status: 'ok' as const }), unfollow: async () => ({ status: 'ok' as const }) },
    cfg: CHURN_DEFAULTS,
  });

  expect(sched.nextDue(clock.now())!.accountPk).toBe('zzz');
  store.close();
});
