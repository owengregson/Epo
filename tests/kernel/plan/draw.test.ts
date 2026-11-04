/**
 * The draw and the re-plans (spec §5.4, §5.6, §8.3): L13 (Boost survives every cause), L13b (honesty; the kept remainder never grows without a Boost), L14 / L14b (backlog and
 * the multi-day bound), and the probation rule.
 */
import fc from 'fast-check';
import { dayShapeBumps, overnightFloor } from '@/kernel/derive';
import { applyBoost, boostSpan } from '@/kernel/plan/boost';
import { drawBase, drawDayPlan, replanRemainder } from '@/kernel/plan/draw';
import { SESSION_BOUNDARY_MS } from '@/kernel/plan/layout';
import { probationOwed } from '@/kernel/plan/probation';
import { closesAtOf, keptRemainder, NO_USAGE } from '@/kernel/plan/status';
import type { BoostWindow, DayPlan, DrawInput, ReplanCause } from '@/kernel/plan/types';
import { allocateKinds, automaticDayMax } from '@/kernel/plan/volume';
import { MS_PER_DAY, MS_PER_HOUR } from '@/kernel/units';
import { drawInput, emptyDemand, testIntent, windowFor } from '../../kit/plan';

const DAY0 = new Date(2026, 10, 3, 12).getTime();
const boostOver = (input: DrawInput, fromH: number, hours: number): BoostWindow => {
  const startedAt = input.window.startsAt + fromH * MS_PER_HOUR;
  return { v: 1, startedAt, endsAt: startedAt + hours * MS_PER_HOUR, durationMs: hours * MS_PER_HOUR, endedAt: null, endReason: null };
};
const sum = (p: DayPlan, f: (s: DayPlan['sessions'][number]) => number): number => p.sessions.reduce((a, s) => a + f(s), 0);

describe('L13: Boost survives every cause', () => {
  const causes: ReplanCause[] = ['day-start', 'first-open', 'settings', 'demand', 'boost-start', 'boost-end', 'clock', 'repair'];

  test.each(causes)('%s: sessions starting in the window carry the Boost mix with no unfollows; totals stay bounded', (cause) => {
    for (let day = 0; day < 6; day += 1) {
      const base = drawInput(DAY0 + day * MS_PER_DAY, { intent: testIntent({ cleanupShare: 0.71 }),
        demand: emptyDemand({ lifecycleDueByDayEnd: 8, pruneStock: 50, pendingRequests: 2 }) });
      const input = { ...base, boost: boostOver(base, 4, 12) };
      const now = base.window.startsAt + 4 * MS_PER_HOUR;
      const prev = drawBase(base, { now });
      const plan = cause === 'day-start' || cause === 'first-open' ? drawDayPlan(input, { now, cause })
        : replanRemainder(prev, input, now, NO_USAGE, cause);
      const span = boostSpan(input.boost, plan.window);
      expect(span).not.toBeNull();
      for (const s of plan.sessions) {
        if (s.budget > 0 && s.startAt >= (span?.t0 ?? 0) && s.startAt < (span?.t1 ?? 0)) {
          expect(s.tempo.mix).toBe('boost');
          expect(s.mix.unfollow).toBe(0);
        }
      }
      expect(sum(plan, (s) => s.budget)).toBeLessThanOrEqual(plan.ceilings.automaticMax);
      expect(plan.kinds.follow).toBeLessThanOrEqual(input.intent.operatingRate);
      expect(sum(plan, (s) => s.mix.follow + s.mix.unfollow + s.mix.accept)).toBeLessThanOrEqual(sum(plan, (s) => s.budget));
    }
  });

  test('the remainder grows by exactly the placed lift; tempo and ceilings never move', () => {
    for (let day = 0; day < 10; day += 1) {
      const base = drawInput(DAY0 + day * MS_PER_DAY);
      const now = base.window.startsAt + 5 * MS_PER_HOUR;
      const plain = drawBase(base, { now });
      const boosted = drawDayPlan({ ...base, boost: boostOver(base, 5, 12) }, { now });
      const lift = Math.max(0, plain.ceilings.automaticMax - plain.volume.drawn);
      const grew = keptRemainder(boosted, now, NO_USAGE) - keptRemainder(plain, now, NO_USAGE);
      expect(grew).toBeGreaterThanOrEqual(0);
      expect(grew).toBeLessThanOrEqual(lift);
      expect(boosted.ceilings).toEqual(plain.ceilings);
      const paces = (p: DayPlan) => p.sessions.filter((s) => s.startAt > now).map((s) => s.tempo.pace).sort();
      for (const pace of paces(boosted)) expect(pace).toBeGreaterThanOrEqual(0.7);
    }
  });

  test('insertion keys on run intent: running opens a session now, stopped never does', () => {
    let inserted = 0;
    for (let day = 0; day < 10; day += 1) {
      const base = drawInput(DAY0 + day * MS_PER_DAY);
      const plain = drawBase(base);
      const gapStart = plain.sessions.find((s, i) => i > 0 && s.startAt - plain.sessions[i - 1].expectedEndAt > 3 * MS_PER_HOUR);
      if (gapStart === undefined) continue;
      const now = gapStart.startAt - 90 * 60_000;
      const window = { ...base, boost: { ...boostOver(base, 0, 20), startedAt: now, endsAt: now + 4 * MS_PER_HOUR } };
      const running = drawDayPlan({ ...window, runIntent: 'running' }, { now });
      const stopped = drawDayPlan({ ...window, runIntent: 'stopped' }, { now });
      expect(stopped.sessions.some((s) => s.startAt === now)).toBe(false);
      if (running.sessions.some((s) => s.startAt === now)) inserted += 1;
    }
    expect(inserted).toBeGreaterThan(0);
  });
});

describe('L13b: honesty', () => {
  test('with nothing to swap and no lift, Boost changes no budget', () => {
    const base = drawInput(DAY0, { intent: testIntent({ acceptRequests: false }) });
    const plain = drawBase(base);
    const topped = { ...plain, volume: { ...plain.volume, drawn: plain.ceilings.automaticMax } };
    const out = applyBoost(topped, { ...base, boost: boostOver(base, 0, 24), runIntent: 'stopped' }, base.window.startsAt, NO_USAGE);
    expect(out.sessions.map((s) => s.budget)).toEqual(topped.sessions.map((s) => s.budget));
    expect(out.kinds.follow + out.kinds.slack).toBe(topped.kinds.follow + topped.kinds.slack);
  });

  test('no re-plan without an active Boost grows the kept remainder', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 22 }),
      fc.constantFrom<ReplanCause>('settings', 'demand', 'boost-end'), (day, hour, cause) => {
        const base = drawInput(DAY0 + day * MS_PER_DAY);
        const prev = drawDayPlan(base);
        const now = base.window.startsAt + hour * MS_PER_HOUR;
        const next = replanRemainder(prev, { ...base, intent: testIntent({ operatingRate: 75 }) }, now, NO_USAGE, cause);
        return keptRemainder(next, now, NO_USAGE) <= keptRemainder(prev, now, NO_USAGE);
      }), { numRuns: 40 });
  });
});

describe('L14 / L14b: backlog and the week', () => {
  test('a backlog clears within ⌈excess / (V/4)⌉ days and u_max is never exceeded', () => {
    const intent = testIntent({ acceptRequests: false });
    for (const excess of [10, 40, 120]) {
      const v = 40;
      let backlog = excess + Math.floor(v / 2);
      let days = 0;
      while (backlog > Math.floor(v / 2)) {
        const k = allocateKinds(v, intent, emptyDemand({ lifecycleDueByDayEnd: backlog, lifecycleBacklog: backlog }), false);
        expect(k.unfollow).toBeLessThanOrEqual(Math.floor(v / 2));
        backlog -= k.lifecycleUnfollow;
        days += 1;
      }
      expect(days).toBeLessThanOrEqual(Math.ceil(excess / (v / 4)));
    }
  });

  test('over a week, Boosts add at most the lifts plus the unfollows they moved; no day passes automaticDayMax', () => {
    let extra = 0;
    let allowance = 0;
    for (let day = 0; day < 7; day += 1) {
      const base = drawInput(DAY0 + day * MS_PER_DAY, { intent: testIntent({ cleanupShare: 0.71 }),
        demand: emptyDemand({ lifecycleDueByDayEnd: 6, pruneStock: 80 }) });
      const now = base.window.startsAt + 6 * MS_PER_HOUR;
      const plain = drawBase(base, { now });
      const boosted = drawDayPlan({ ...base, boost: boostOver(base, 6, 12) }, { now });
      extra += boosted.kinds.follow - plain.kinds.follow;
      allowance += Math.max(0, plain.ceilings.automaticMax - plain.volume.drawn) + (plain.kinds.unfollow - boosted.kinds.unfollow)
        + Math.max(0, plain.kinds.slack - boosted.kinds.slack);
      expect(sum(boosted, (s) => s.budget)).toBeLessThanOrEqual(automaticDayMax(base.intent.operatingRate));
    }
    expect(extra).toBeLessThanOrEqual(allowance);
  });
});

describe('probation', () => {
  const windowOf = (t: number) => windowFor(t);

  test('owed after a full plan-day length, or when a complete plan-day lies between', () => {
    const start = windowFor(DAY0).startsAt + 10 * MS_PER_HOUR;
    expect(probationOwed(start - MS_PER_DAY, start, windowOf)).toBe(true);
    expect(probationOwed(start - 2 * MS_PER_HOUR, start, windowOf)).toBe(false);
    expect(probationOwed(null, start, windowOf)).toBe(false);
    const yesterdayLate = windowFor(DAY0).startsAt - 30 * 60_000;
    expect(probationOwed(yesterdayLate, start, windowOf)).toBe(false);
  });

  test('an absence ≥ 24 h always owes it, at any start', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 60 * MS_PER_DAY }), fc.integer({ min: MS_PER_DAY, max: 9 * MS_PER_DAY }),
      (t, gap) => probationOwed(DAY0 + t, DAY0 + t + gap, windowOf)));
  });

  test('the draw marks the first kept session owed, and its gap paces against the probation cap', () => {
    const input = drawInput(DAY0);
    const plan = drawBase(input, { upgradeProbation: true });
    const first = plan.sessions.find((s) => s.budget > 0);
    expect(first?.tempo.probation).toBe(true);
    expect(plan.sessions.filter((s) => s.tempo.probation)).toHaveLength(1);
  });

  test('a slower final probation session fits before quiet hours with the existing boundary reserve', () => {
    const base = testIntent();
    const intent = testIntent({ quietHours: { startMinute: 270, endMinute: 480 }, restDayProbability: 0,
      shape: { ...base.shape, bumps: dayShapeBumps('nightowl'), overnightFloor: overnightFloor('nightowl') } });
    for (const installEntropy of [0x5eed, 0x6000, 1610612736]) {
      const input = drawInput(new Date(2026, 10, 9, 12).getTime(), { intent, installEntropy });
      const plain = drawBase(input);
      const last = plain.sessions[plain.sessions.length - 1];
      const plan = drawBase(input, { probationAt: (at) => at === last.startAt });
      const i = plan.sessions.findIndex((s) => s.tempo.probation);
      const s = plan.sessions[i];
      expect(s.tempo.probation).toBe(true);
      expect(s.expectedEndAt + SESSION_BOUNDARY_MS).toBeLessThanOrEqual(closesAtOf(plan, i, intent.quietHours));
      expect(plan.volume.planned).toBeLessThanOrEqual(plain.volume.planned);
      for (const session of plan.sessions) expect(session.mix.follow + session.mix.unfollow + session.mix.accept).toBeLessThanOrEqual(session.budget);
      expect(plan.kinds.slack).toBeGreaterThanOrEqual(0);
    }
  });

  test('a normal slot too short for probation contributes zero and leaves probation for the next viable session', () => {
    const startsAt = new Date(2026, 10, 9).getTime();
    const base = testIntent();
    const intent = testIntent({ operatingRate: 5, hardCeiling: 10, volumeSigma: 0, restDayProbability: 0,
      sessions: { min: 5, max: 5 }, quietHours: { startMinute: 35, endMinute: 480 },
      shape: { ...base.shape, bumps: dayShapeBumps('nightowl'), overnightFloor: overnightFloor('nightowl') } });
    const input = drawInput(startsAt, { intent, installEntropy: 12,
      window: { key: '2026-11-09', startsAt, endsAt: startsAt + MS_PER_DAY }, firstOpenAt: startsAt });
    expect(drawBase(input).sessions[0].budget).toBe(1);
    const plan = drawBase(input, { upgradeProbation: true });
    const first = plan.sessions[0];
    expect(first).toMatchObject({ budget: 0, mix: { follow: 0, unfollow: 0, accept: 0 }, tempo: { probation: false } });
    expect(first.expectedEndAt).toBe(first.startAt);
    expect(plan.sessions[1]).toMatchObject({ budget: 1, tempo: { probation: true } });
    expect(plan.sessions.filter((s) => s.tempo.probation)).toHaveLength(1);
    expect(plan.volume.planned).toBe(4);
    expect(plan.kinds.slack).toBeGreaterThanOrEqual(0);
  });
});
