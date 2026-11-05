/**
 * The pure plan view (spec §5.5, §5.7, §5.8.3): reads never write; session states with the one
 * late-join rule; typed refusals with exact `until`s; R and the remaining work; the census host
 * (law L15); accepts per pass (law L12); follows never pass P0 at run time (law L1).
 */
import fc from 'fast-check';
import { viewPlan } from '@/governors/plan-view';
import { drawBase, drawDayPlan } from '@/kernel/plan/draw';
import type { DayPlan } from '@/kernel/plan/types';
import { MS_PER_DAY, MS_PER_HOUR } from '@/kernel/units';
import { drawInput, noUse, testIntent, viewInputs } from '../kit/plan';

const DAY0 = new Date(2026, 10, 3, 12).getTime();
const input = drawInput(DAY0);
const plan = drawBase(input);
const first = plan.sessions.find((s) => s.budget > 0) as DayPlan['sessions'][number];
const firstIdx = plan.sessions.indexOf(first);

const deepFreeze = <T>(o: T): T => {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
};

test('10 000 random reads never write the plan', () => {
  const frozen = deepFreeze(drawDayPlan(drawInput(DAY0)));
  const before = JSON.stringify(frozen);
  const base = viewInputs(frozen, frozen.window.startsAt);
  fc.assert(fc.property(fc.integer({ min: -2 * MS_PER_HOUR, max: 26 * MS_PER_HOUR }), fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 5 }),
    (dt, auto, k) => {
      const v = viewPlan(frozen, { ...base, now: frozen.window.startsAt + dt, used: noUse({ all: auto, auto, follow: auto }) });
      v.admits('follow', 'growth');
      v.admits('unfollow', 'woven', { pk: '1' });
      v.manualOpen();
      v.checkDue(null);
      v.censusDue({ lastCompleteAt: null, walkPages: 10 });
      v.acceptsAllowed(3, 1);
      v.mixDraw(k);
      v.planDayStartAfter(k);
      return true;
    }), { numRuns: 10_000 });
  expect(JSON.stringify(frozen)).toBe(before);
});

describe('session states', () => {
  test('before, during and after the first session', () => {
    const before = viewPlan(plan, viewInputs(plan, first.startAt - 1));
    expect(before.sessions[firstIdx].state).toBe('next');
    expect(before.open).toBeNull();
    expect(before.nextSessionAt).toBe(first.startAt);
    const during = viewPlan(plan, viewInputs(plan, first.startAt + 1));
    expect(during.open?.idx).toBe(firstIdx);
    expect(during.sessions[firstIdx].state).toBe('now');
    const missed = viewPlan(plan, viewInputs(plan, first.expectedEndAt + 1));
    expect(missed.sessions[firstIdx].state).toBe('skipped');
  });

  test('a late join never unlocks more than still fits', () => {
    const late = first.expectedEndAt - 2 * first.tempo.gap.targetMeanMs - 1;
    const v = viewPlan(plan, viewInputs(plan, late));
    expect(v.sessions[firstIdx].budget).toBeLessThanOrEqual(2);
  });

  test('a joined session is done once it spends its budget', () => {
    const perSession = plan.sessions.map((_, i) => (i === firstIdx ? first.budget : 0));
    const v = viewPlan(plan, viewInputs(plan, first.startAt + MS_PER_HOUR / 2, { used: noUse({ perSession, all: first.budget, auto: first.budget }) }));
    expect(v.sessions[firstIdx].state).toBe('done');
  });

  test('R and remaining: min(R, V − used.auto, M − used.all − outside)', () => {
    const v = viewPlan(plan, viewInputs(plan, plan.window.startsAt, { used: noUse({ all: 60, outside: 3 }) }));
    expect(v.R).toBe(plan.sessions.reduce((a, s) => a + s.budget, 0));
    expect(v.remaining).toBe(Math.max(0, Math.min(v.R, plan.volume.drawn, plan.ceilings.day - 63)));
  });

  test('with today over, the next session is tomorrow\'s first; with none, parks end at the boundary', () => {
    const tomorrow = drawBase(drawInput(DAY0 + MS_PER_DAY));
    const late = plan.window.endsAt - 1;
    expect(viewPlan(plan, viewInputs(plan, late, { tomorrow: () => tomorrow })).nextSessionAt)
      .toBe(tomorrow.sessions.find((s) => s.budget > 0)?.startAt);
    expect(viewPlan(plan, viewInputs(plan, late)).nextSessionAt).toBeNull();
  });
});

describe('admission', () => {
  const during = first.startAt + 1;
  const at = (over: Parameters<typeof viewInputs>[2] = {}, now = during) => viewPlan(plan, viewInputs(plan, now, over));

  test('between sessions an automatic action parks to the next session; a single manual one runs', () => {
    const early = at({}, first.startAt - 1).admits('follow', 'growth');
    expect(early.ok === false && ['quiet-hours', 'session-closed'].includes(early.reason) && early.until).toBe(first.startAt);
    const gap = plan.sessions.find((s, i) => i > firstIdx && s.budget > 0);
    if (gap !== undefined) {
      const v = at({}, gap.startAt - 1);
      expect(v.admits('follow', 'growth')).toEqual({ ok: false, reason: 'session-closed', until: gap.startAt });
      expect(v.admits('follow', 'manual')).toEqual({ ok: true });
    }
  });

  test('typed refusals with exact untils', () => {
    expect(at().admits('follow', 'growth')).toEqual({ ok: true });
    expect(at({ journal: { blocks: () => true } }).admits('unfollow', 'woven', { pk: '9' }).ok).toBe(false);
    expect(at({ unconfirmed: { kind: 'unfollow', streak: 2 } }).admits('unfollow', 'woven')).toEqual({ ok: false, reason: 'unconfirmed', until: null });
    expect(at({ used: noUse({ all: plan.ceilings.day }) }).admits('follow', 'manual')).toEqual({ ok: false, reason: 'ceiling', until: plan.window.endsAt });
    const recent = Array.from({ length: plan.ceilings.hour }, (_, i) => during - (plan.ceilings.hour - i) * 60_000);
    expect(at({ hourly: { lastHour: plan.ceilings.hour, recentTimes: recent } }).admits('follow', 'growth'))
      .toEqual({ ok: false, reason: 'hourly-cap', until: recent[0] + MS_PER_HOUR });
    expect(at({ deadline: during + 5_000 }).admits('follow', 'growth')).toEqual({ ok: false, reason: 'deadline', until: during + 5_000 });
    expect(at({ used: noUse({ auto: plan.volume.drawn, all: plan.volume.drawn }) }).admits('follow', 'growth').ok).toBe(false);
    const boost = { v: 1 as const, startedAt: during - 1, endsAt: during + MS_PER_HOUR, durationMs: MS_PER_HOUR, endedAt: null, endReason: null };
    expect(at({ boost }).admits('unfollow', 'woven')).toEqual({ ok: false, reason: 'deferred-by-boost', until: boost.endsAt });
  });

  test('a day off refuses automatic work until the boundary', () => {
    const offInput = drawInput(DAY0, { intent: testIntent({ daysOff: [new Date(input.window.startsAt).getDay() as 0] }) });
    const off = drawBase(offInput);
    expect(off.sessions).toHaveLength(0);
    expect(viewPlan(off, viewInputs(off, off.window.startsAt + 10 * MS_PER_HOUR)).admits('follow', 'growth'))
      .toEqual({ ok: false, reason: 'day-off', until: off.window.endsAt });
  });

  test('L1 at run time: follows stop at P0 whatever else is available', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 80 }), (follows) => {
      const v = at({ used: noUse({ follow: follows, all: follows, auto: Math.min(follows, 10) }) });
      const ok = v.admits('follow', 'growth').ok;
      return follows < plan.ceilings.followDay || !ok;
    }));
  });

  test('L12: accepts per pass stay under the pass bound and the hour', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 30 }), (pending, lastHour) => {
      const n = at().acceptsAllowed(pending, lastHour);
      return n >= 0 && n <= plan.ceilings.acceptsPerPass && n <= Math.max(0, plan.ceilings.hour - lastHour - 1) && n <= pending;
    }));
  });
});

describe('checks and the census (L15)', () => {
  const cleanup = testIntent({ cleanupShare: 0.71 });
  const during = first.startAt + 1;

  test('a check is due at each session start and then every spacing after the sweep\'s end', () => {
    const v = viewPlan(plan, viewInputs(plan, during));
    expect(v.checkDue(null)).toBe(true);
    expect(v.checkDue(first.startAt - 1)).toBe(true);
    expect(v.checkDue(during)).toBe(false);
    expect(viewPlan(plan, viewInputs(plan, during + 2 * MS_PER_HOUR)).checkDue(during)).toBe(first.expectedEndAt > during + 2 * MS_PER_HOUR);
  });

  test('an overdue census runs in the first eligible session, never in Boost or probation, never too large', () => {
    const v = viewPlan(plan, viewInputs(plan, during, { intent: cleanup }));
    expect(v.censusDue({ lastCompleteAt: null, walkPages: 3 })).toBe(true);
    expect(v.censusDue({ lastCompleteAt: during - 1, walkPages: 3 })).toBe(plan.demand.pruneStock < plan.kinds.unfollow - plan.kinds.lifecycleUnfollow);
    expect(v.censusDue({ lastCompleteAt: null, walkPages: 5_000 })).toBe(false);
    expect(viewPlan(plan, viewInputs(plan, during)).censusDue({ lastCompleteAt: null, walkPages: 3 })).toBe(false);
    const boost = { v: 1 as const, startedAt: during - 1, endsAt: during + MS_PER_HOUR, durationMs: MS_PER_HOUR, endedAt: null, endReason: null };
    const boosted = drawDayPlan({ ...input, intent: cleanup, boost }, { now: during });
    const b = boosted.sessions.findIndex((s) => s.tempo.mix === 'boost' && s.startAt <= during && s.expectedEndAt > during);
    if (b >= 0) expect(viewPlan(boosted, viewInputs(boosted, during, { intent: cleanup, boost })).censusDue({ lastCompleteAt: null, walkPages: 3 })).toBe(false);
    const gentle = viewPlan(plan, viewInputs(plan, during, { intent: cleanup, upgradeProbation: true }));
    expect(gentle.open?.probation).toBe(true);
    expect(gentle.censusDue({ lastCompleteAt: null, walkPages: 3 })).toBe(false);
  });

  test('a Boost session checks light', () => {
    const boost = { v: 1 as const, startedAt: during - 1, endsAt: during + MS_PER_HOUR, durationMs: MS_PER_HOUR, endedAt: null, endReason: null };
    const boosted = drawDayPlan({ ...input, boost }, { now: during });
    expect(viewPlan(boosted, viewInputs(boosted, during, { boost })).checkLight()).toBe(true);
    expect(viewPlan(plan, viewInputs(plan, during)).checkLight()).toBe(false);
  });
});
