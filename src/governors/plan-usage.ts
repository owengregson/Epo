/** The same ledger windows drive session totals, late joins and per-kind admission. */
import { windowEndOf } from '../kernel/plan/status';
import type { DayPlan } from '../kernel/plan/types';
import type { PlanStore, UsageTally } from './plan-types';

export function planUsage(store: PlanStore, plan: DayPlan, now: number, outside: number): UsageTally & {
  readonly joinedAt: readonly (number | null)[];
} {
  const tally = store.tallySince(plan.window.startsAt);
  const times = store.recentMutationTimes(plan.window.startsAt).filter((t) => t < plan.window.endsAt && t <= now);
  const inside = plan.sessions.map((s, i) => times.filter((t) => t >= s.startAt && t < windowEndOf(plan, i)));
  const perSessionKinds = plan.sessions.map((s, i) => {
    const from = store.tallySince(s.startAt);
    const to = store.tallySince(windowEndOf(plan, i));
    return { follow: from.follow - to.follow, unfollow: from.unfollow - to.unfollow, accept: from.accept - to.accept };
  });
  return { ...tally, perSession: inside.map((ts) => ts.length), perSessionKinds,
    joinedAt: inside.map((ts) => (ts.length > 0 ? Math.min(...ts) : null)), outside };
}
