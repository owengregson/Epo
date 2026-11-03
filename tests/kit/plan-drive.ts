/**
 * The automatic loop the plan integration tests drive (I1, I11): the production cadence, read budget and
 * plan over a real store, stepped the way the engine loop steps them — the preflight, the click review's
 * verify read, the deadline armed at dispatch, the settle, the wait on that deadline, a park until a
 * refusal's `until`. Every write is a follow; what each plan-day planned and spent is recorded.
 */
import type { DayPlan } from '@/kernel/plan';
import type { PlanWiring } from '@/main/services/plan-wiring';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/timing/units';
import type { PlanClock } from './harness-plan';

/** One automatic write the loop landed, with the session it ran in and that session's gap floor. */
export interface DrivenWrite {
  readonly at: number;
  readonly day: string;
  readonly session: number;
  readonly floorMs: number;
  /** The rolling-hour cap the write was admitted under (the probation cap in a probation session). */
  readonly hourCap: number;
}

export interface PlanDrive {
  readonly writes: DrivenWrite[];
  /** Each plan-day's plan, as the loop last saw it. */
  readonly plans: Map<string, DayPlan>;
  /** Each plan-day's plan revisions and draw instants as the loop saw them. */
  readonly draws: Map<string, Set<string>>;
  /** Hours (epoch hour index) in which the loop parked on the rolling-hour cap. */
  readonly hourlyParks: Set<number>;
  /** Hours of kept sessions the loop saw planned. */
  sessionHours: number;
}

/** One automatic follow, written through the journal the way a landed dispatch settles. */
export function settleFollow(store: KnowledgeStore, pk: string, at: number): void {
  const intent = store.beginEffectIntent({ accountPk: pk, username: pk, action: 'follow', channel: 'growth', at });
  store.markEffectDispatched(intent.id, at);
  store.settleEffectIntent(intent.id, { at, result: 'ok', ledger: 'growth' });
}

/** The loop over `days` from the clock: act while admitted, wait on the armed deadline, park on a refusal. */
export function drivePlan(plan: PlanWiring, store: KnowledgeStore, clock: PlanClock, days: number): PlanDrive {
  const run: PlanDrive = { writes: [], plans: new Map(), draws: new Map(), hourlyParks: new Set(), sessionHours: 0 };
  const seenSessions = new Set<string>();
  const end = clock.now() + days * MS_PER_DAY;
  for (let guard = 0, n = 0; clock.now() < end && guard < 100_000; guard += 1) {
    const now = clock.now();
    const view = plan.pacing.ensureIfProvisional(now);
    const day = view.window.key;
    run.plans.set(day, view.plan);
    run.draws.set(day, (run.draws.get(day) ?? new Set()).add(`${view.plan.revision}@${view.plan.drawnAt}`));
    for (const s of view.plan.sessions) {
      const key = `${day}:${s.startAt}`;
      if (s.budget > 0 && !seenSessions.has(key)) {
        seenSessions.add(key);
        run.sessionHours += (s.expectedEndAt - s.startAt) / MS_PER_HOUR;
      }
    }
    const pk = `p${n}`;
    const admission = plan.cadence.preflight('follow', 'growth', now, { pk });
    // The click review's one verify read, admitted by the plan's read budget before the visit.
    const read = admission.ok ? plan.readBudget.consume('profile', 'reconciliation', 1, 'verify') : null;
    if (admission.ok && read?.allowed) {
      const deadline = plan.cadence.armAtDispatch('follow', 'growth', now, { pk });
      settleFollow(store, pk, now);
      n += 1;
      const hourCap = view.open?.probation ? view.plan.ceilings.probationHour : view.plan.ceilings.hour;
      run.writes.push({ at: now, day, session: view.open?.idx ?? -1, floorMs: view.tempo.gap.floorMs, hourCap });
      clock.t = deadline;
      continue;
    }
    if (!admission.ok && admission.reason === 'hourly-cap') run.hourlyParks.add(Math.floor(now / MS_PER_HOUR));
    const until = (admission.ok ? read?.resumeAt : admission.until) ?? view.nextSessionAt ?? view.window.endsAt;
    clock.t = until > now ? until : now + MS_PER_MINUTE;
  }
  return run;
}

/** Writes per plan-day. */
export function perDay(run: Pick<PlanDrive, 'writes'>): Map<string, number> {
  const byDay = new Map<string, number>();
  for (const w of run.writes) byDay.set(w.day, (byDay.get(w.day) ?? 0) + 1);
  return byDay;
}

/** The most writes any rolling hour ending at a write holds. */
export function peakHour(run: Pick<PlanDrive, 'writes'>): number {
  let peak = 0;
  for (let i = 0, lo = 0; i < run.writes.length; i += 1) {
    while (run.writes[lo].at <= run.writes[i].at - MS_PER_HOUR) lo += 1;
    peak = Math.max(peak, i - lo + 1);
  }
  return peak;
}
