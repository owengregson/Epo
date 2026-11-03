/**
 * The plan service (spec §5.1, §5.6, §8.2): view never writes; ensure writes only on a cause, in one
 * write; a late first open prorates; missed sessions forfeit; the open session survives stop/start;
 * a settings re-plan keeps the seed and the proration; DST, a day-shape transition and a backward
 * clock re-plan correctly; Boost obeys its clock rules and survives settings, the plan-day edge and
 * a repair.
 */
import { PlanService } from '@/governors/plan-service';
import { parsePlanState } from '@/governors/plan-state';
import { CLOCK_TOLERANCE_MS } from '@/kernel/tempo-policy';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { memoryPlanStore, planDeps, testIntent, windowFor } from '../kit/plan';

const NOON = new Date(2026, 10, 3, 12).getTime();
const W = windowFor(NOON);

const setup = (t: number, over: Parameters<typeof planDeps>[2] = {}) => {
  const store = memoryPlanStore();
  const clock = { t };
  return { store, clock, service: new PlanService(planDeps(store, clock, over)) };
};
const stateOf = (raw: string | null) => parsePlanState(raw).state;

describe('one writer', () => {
  test('reads never write (provisional before the first ensure, 10 000 after it); ensure writes only on a cause', () => {
    const t0 = W.startsAt + 9 * MS_PER_HOUR;
    const { store, service } = setup(t0);
    for (let i = 0; i < 20; i += 1) expect(service.view(t0 + i * MS_PER_MINUTE).provisional).toBe(true);
    expect(store.writes).toBe(0);
    service.ensure(t0);
    expect(store.writes).toBe(1);
    for (let i = 0; i < 10_000; i += 1) service.view(t0 + i * 1000);
    for (let i = 0; i < 50; i += 1) service.ensure(t0 + i * MS_PER_MINUTE);
    expect(store.writes).toBe(1);
    expect(service.view(t0 + MS_PER_HOUR).provisional).toBe(false);
  });

  test('bookkeeping never re-plans: mutations in the ledger do not write', () => {
    const { store, service } = setup(W.startsAt + 9 * MS_PER_HOUR);
    service.ensure();
    store.mutations.push({ at: W.startsAt + 9 * MS_PER_HOUR + 1, kind: 'follow', auto: true });
    service.ensure(W.startsAt + 10 * MS_PER_HOUR);
    expect(store.writes).toBe(1);
  });
});

describe('the day', () => {
  test('a late first open prorates the sessions already over; missed sessions forfeit', () => {
    const late = setup(W.startsAt + 20 * MS_PER_HOUR).service.ensure();
    const early = setup(W.startsAt + MS_PER_HOUR).service.ensure();
    const sum = (v: typeof late) => v.plan.sessions.reduce((a, s) => a + s.budget, 0);
    expect(sum(late)).toBeLessThanOrEqual(sum(early));
    expect(late.plan.sessions.filter((s) => s.before === 'first-open').every((s) => s.budget === 0)).toBe(true);
    expect(late.plan.firstOpenAt).toBe(W.startsAt + 20 * MS_PER_HOUR);
  });

  test('the open session survives a stop and a start (no re-plan, same plan)', () => {
    const { store, service } = setup(W.startsAt + MS_PER_HOUR);
    const first = service.ensure().plan.sessions.find((s) => s.budget > 0);
    if (first === undefined) return;
    const during = first.startAt + 1;
    const a = service.ensure(during);
    const b = service.ensure(during + 5 * MS_PER_MINUTE);
    expect(b.plan).toEqual(a.plan);
    expect(b.open?.idx).toBe(a.open?.idx);
    expect(store.writes).toBe(1);
  });

  test('a settings change re-plans the remainder with the same seed and the same proration', () => {
    let intent = testIntent();
    const { store, service } = setup(W.startsAt + 8 * MS_PER_HOUR, { intent: () => intent });
    const before = service.ensure();
    intent = testIntent({ hourlyCap: 14 });
    const after = service.onSettings(W.startsAt + 9 * MS_PER_HOUR);
    expect(after.plan.seed).toBe(before.plan.seed);
    expect(after.plan.firstOpenAt).toBe(before.plan.firstOpenAt);
    expect(after.plan.cause).toBe('settings');
    expect(store.writes).toBe(2);
    expect(service.onSettings(W.startsAt + 9 * MS_PER_HOUR + 1).plan.revision).toBe(after.plan.revision);
  });

  test('the plan-day edge draws the next window (day-start); DST windows keep whole counters', () => {
    const { service } = setup(W.startsAt + MS_PER_HOUR);
    const today = service.ensure();
    const tomorrow = service.ensure(today.plan.window.endsAt + MS_PER_MINUTE);
    expect(tomorrow.plan.window.startsAt).toBe(today.plan.window.endsAt);
    expect(tomorrow.plan.cause).toBe('day-start');
    expect(tomorrow.plan.ceilings.day).toBe(testIntent().hardCeiling);
  });

  test('a day-shape change keeps today\'s window and runs a 12–36 h transition day next', () => {
    let intent = testIntent();
    const { service } = setup(W.startsAt + MS_PER_HOUR, { intent: () => intent });
    const today = service.ensure();
    intent = testIntent({ quietHours: { startMinute: 1 * 60, endMinute: 9 * 60 } });
    expect(service.ensure(W.startsAt + 2 * MS_PER_HOUR).plan.window).toEqual(today.plan.window);
    const next = service.ensure(today.plan.window.endsAt + MS_PER_MINUTE).plan.window;
    expect(next.startsAt).toBe(today.plan.window.endsAt);
    const hours = (next.endsAt - next.startsAt) / MS_PER_HOUR;
    expect(hours).toBeGreaterThanOrEqual(12);
    expect(hours).toBeLessThanOrEqual(37);
  });

  test('a backward clock re-plans the window (clock)', () => {
    const { service } = setup(W.startsAt + 10 * MS_PER_HOUR);
    service.ensure();
    const v = service.ensure(W.startsAt + 10 * MS_PER_HOUR - CLOCK_TOLERANCE_MS - MS_PER_MINUTE);
    expect(v.plan.cause).toBe('clock');
  });

  test('a corrupt plan_state is repaired deterministically and warned about', () => {
    const warn = jest.fn();
    const store = memoryPlanStore();
    const clock = { t: W.startsAt + 9 * MS_PER_HOUR };
    const service = new PlanService(planDeps(store, clock), { log: { warn } });
    const good = service.ensure();
    const raw = JSON.parse(store.raw ?? '{}');
    store.raw = JSON.stringify({ ...raw, plan: { ...raw.plan, sessions: 'bad' } });
    const repaired = service.ensure();
    expect(warn).toHaveBeenCalled();
    expect(repaired.plan.cause).toBe('repair');
    expect(repaired.plan.window).toEqual(good.plan.window);
    expect(repaired.plan.sessions.map((s) => s.startAt)).toEqual(good.plan.sessions.map((s) => s.startAt));
  });

  test('an install with a ledger and no plan_state owes upgrade probation', () => {
    const { store, service } = setup(W.startsAt + MS_PER_HOUR);
    store.mutations.push({ at: W.startsAt - 5 * MS_PER_DAY, kind: 'follow', auto: true });
    service.ensure();
    expect(stateOf(store.raw)?.upgradeProbation).toBe(true);
    expect(service.ensure().plan.sessions.find((s) => s.budget > 0)?.tempo.probation).toBe(true);
  });
});

describe('Boost', () => {
  const at = W.startsAt + 9 * MS_PER_HOUR;

  test('start writes the window and the re-plan in one write; end is one write too', () => {
    const { store, service } = setup(at);
    service.ensure();
    const writes = store.writes;
    const on = service.startBoost(4 * MS_PER_HOUR, at);
    expect(store.writes).toBe(writes + 1);
    expect(on.boost?.endsAt).toBe(at + 4 * MS_PER_HOUR);
    expect(on.plan.cause).toBe('boost-start');
    const off = service.endBoost('user', at + MS_PER_HOUR);
    expect(store.writes).toBe(writes + 2);
    expect(stateOf(store.raw)?.boost?.endReason).toBe('user');
    expect(off.boost).toBeNull();
  });

  test('clock rules: expiry ends it; a backward jump ends it (clock); a tampered window is clamped', () => {
    const { store, service } = setup(at);
    service.startBoost(2 * MS_PER_HOUR, at);
    service.ensure(at + 3 * MS_PER_HOUR);
    expect(stateOf(store.raw)?.boost?.endReason).toBe('expired');
    service.startBoost(2 * MS_PER_HOUR, at + 4 * MS_PER_HOUR);
    service.ensure(at + 4 * MS_PER_HOUR - CLOCK_TOLERANCE_MS - MS_PER_MINUTE);
    expect(stateOf(store.raw)?.boost?.endReason).toBe('clock');
    service.startBoost(MS_PER_HOUR, at + 5 * MS_PER_HOUR);
    const raw = JSON.parse(store.raw ?? '{}');
    store.raw = JSON.stringify({ ...raw, boost: { ...raw.boost, endsAt: raw.boost.endsAt + 9 * MS_PER_HOUR } });
    service.ensure(at + 5 * MS_PER_HOUR + MS_PER_MINUTE);
    expect(stateOf(store.raw)?.boost?.endsAt).toBe(at + 6 * MS_PER_HOUR);
  });

  test('Boost survives a settings change, the plan-day edge and a repair', () => {
    let intent = testIntent();
    const store = memoryPlanStore();
    const clock = { t: W.endsAt - 3 * MS_PER_HOUR };
    const service = new PlanService(planDeps(store, clock, { intent: () => intent }), { log: { warn: () => {} } });
    service.startBoost(20 * MS_PER_HOUR, clock.t);
    intent = testIntent({ hourlyCap: 14 });
    expect(service.onSettings(clock.t + MS_PER_MINUTE).boost).not.toBeNull();
    const nextDay = service.ensure(W.endsAt + 6 * MS_PER_HOUR);
    expect(nextDay.boost).not.toBeNull();
    const boosted = nextDay.plan.sessions.filter((s) => s.budget > 0 && s.startAt >= W.endsAt + 6 * MS_PER_HOUR
      && s.startAt < (nextDay.boost?.endsAt ?? 0));
    for (const s of boosted) expect([s.tempo.mix, s.mix.unfollow]).toEqual(['boost', 0]);
    store.raw = JSON.stringify({ ...JSON.parse(store.raw ?? '{}'), plan: { broken: true } });
    const repaired = service.ensure(W.endsAt + 6 * MS_PER_HOUR + MS_PER_MINUTE);
    expect(repaired.boost).not.toBeNull();
    expect(repaired.plan.cause).toBe('repair');
  });

  test('the preview is pure and honest', () => {
    const { store, service } = setup(at);
    service.ensure();
    const writes = store.writes;
    const p = service.previewBoost(4, at);
    expect(store.writes).toBe(writes);
    expect(p.hours).toBe(4);
    expect(p.endsAt).toBe(at + 4 * MS_PER_HOUR);
    expect(p.extraFollowsToday).toBeGreaterThanOrEqual(0);
    expect(service.previewBoost(99, at).hours).toBe(24);
  });

  test('nextEdgeAt is the earliest of the boundary, the Boost end and the next session', () => {
    const { service } = setup(at);
    const v = service.ensure();
    expect(service.nextEdgeAt(at)).toBeLessThanOrEqual(v.plan.window.endsAt);
    service.startBoost(MS_PER_HOUR, at);
    expect(service.nextEdgeAt(at)).toBeLessThanOrEqual(at + MS_PER_HOUR);
  });

  test('previewDays draws whole plan-days for an intent without writing', () => {
    const { store, service } = setup(at);
    const days = service.previewDays(testIntent(), at, 7);
    expect(days).toHaveLength(7);
    expect(store.writes).toBe(0);
    for (let i = 1; i < days.length; i += 1) expect(days[i].startAt).toBe(days[i - 1].endAt);
  });
});
