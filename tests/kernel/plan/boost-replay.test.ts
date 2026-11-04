/** L1/L13: replaying an overlay never grants its lift again or revives skipped act-now sessions. */
import { applyBoost } from '@/kernel/plan/boost';
import { drawBase, drawDayPlan, replanRemainder } from '@/kernel/plan/draw';
import { closesAtOf, NO_USAGE, sessionStatus } from '@/kernel/plan/status';
import type { ReplanCause } from '@/kernel/plan/types';
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/kernel/units';
import { drawInput, testIntent } from '../../kit/plan';

const causes: ReplanCause[] = ['day-start', 'first-open', 'settings', 'demand', 'boost-start', 'boost-end', 'clock', 'repair'];
const at = new Date(2026, 10, 3, 12).getTime();

test.each(causes)('the whole plan sums to at most its automatic ceiling after repeated %s replans', (cause) => {
  const input = drawInput(at, { intent: testIntent({ acceptRequests: false }) });
  const now = input.window.startsAt + 8 * MS_PER_HOUR;
  const boost = { v: 1 as const, startedAt: now, endsAt: now + 12 * MS_PER_HOUR,
    durationMs: 12 * MS_PER_HOUR, endedAt: null, endReason: null };
  const boostedInput = { ...input, boost };
  let plan = drawDayPlan(boostedInput, { now });
  for (let n = 0; n < 6; n += 1) {
    plan = replanRemainder(plan, boostedInput, now + n * 45 * MS_PER_MINUTE, NO_USAGE, cause);
    const budget = plan.sessions.reduce((a, s) => a + s.budget, 0);
    expect({ cause, n, budget }).toEqual({ cause, n, budget: plan.volume.planned });
    expect(budget).toBeLessThanOrEqual(plan.ceilings.automaticMax);
  }
});

test('applying the same overlay twice never grants a second lift', () => {
  const input = drawInput(at, { intent: testIntent({ acceptRequests: false }), runIntent: 'stopped' });
  const now = input.window.startsAt;
  const boost = { v: 1 as const, startedAt: now, endsAt: now + 24 * MS_PER_HOUR,
    durationMs: 24 * MS_PER_HOUR, endedAt: null, endReason: null };
  const boostedInput = { ...input, boost };
  const once = drawDayPlan(boostedInput, { now });
  const twice = applyBoost(once, boostedInput, now, NO_USAGE);
  expect(twice.sessions.map((s) => s.budget)).toEqual(once.sessions.map((s) => s.budget));
});

test('an overlay never extends or revives a skipped session inside its window', () => {
  const input = drawInput(at, { intent: testIntent({ acceptRequests: false }), runIntent: 'stopped' });
  const plain = drawBase(input);
  const now = plain.sessions[0].expectedEndAt + 1;
  const boost = { v: 1 as const, startedAt: input.window.startsAt, endsAt: input.window.endsAt,
    durationMs: input.window.endsAt - input.window.startsAt, endedAt: null, endReason: null };
  const out = applyBoost(plain, { ...input, boost }, now, NO_USAGE);
  expect(sessionStatus(plain, 0, now, NO_USAGE).state).toBe('skipped');
  const skipped = plain.sessions[0];
  expect(out.sessions[0]).toMatchObject({ budget: skipped.budget, expectedEndAt: skipped.expectedEndAt, mix: skipped.mix, tempo: skipped.tempo });
  expect(sessionStatus(out, 0, now, NO_USAGE).state).toBe('skipped');
});

test('lowering a target trims unused history without refunding it when the target rises again', () => {
  const input = drawInput(at);
  const start = input.window.startsAt + 8 * MS_PER_HOUR;
  const boost = { v: 1 as const, startedAt: start, endsAt: start + 12 * MS_PER_HOUR,
    durationMs: 12 * MS_PER_HOUR, endedAt: null, endReason: null };
  const prev = drawDayPlan({ ...input, boost }, { now: start });
  const now = start + 5 * MS_PER_HOUR;
  const lowered = replanRemainder(prev, { ...input, boost, intent: testIntent({ operatingRate: 15 }) }, now, NO_USAGE, 'settings');
  expect(lowered.volume.planned).toBeLessThanOrEqual(lowered.ceilings.automaticMax);
  for (const s of lowered.sessions) expect(s.mix.follow + s.mix.unfollow + s.mix.accept).toBeLessThanOrEqual(s.budget);
  const raised = replanRemainder(lowered, { ...input, boost }, now, NO_USAGE, 'settings');
  expect(raised.volume.planned).toBeLessThanOrEqual(lowered.volume.planned);
  for (const cause of causes) {
    const replayed = replanRemainder(raised, { ...input, boost }, now, NO_USAGE, cause);
    expect({ cause, planned: replayed.volume.planned }).toEqual({ cause, planned: expect.any(Number) });
    expect(replayed.volume.planned).toBeLessThanOrEqual(lowered.volume.planned);
  }
});

test('lowering below actual usage preserves those ledger counts and grants no future budget', () => {
  const input = drawInput(at);
  const prev = drawDayPlan(input);
  const now = prev.sessions[1].startAt;
  const usage = { auto: 20, follow: 20, perSession: [20], joinedAt: [prev.sessions[0].startAt] };
  const next = replanRemainder(prev, { ...input, intent: testIntent({ operatingRate: 15 }) }, now, usage, 'settings');
  expect(next.sessions[0].budget).toBe(20);
  expect(next.volume.planned).toBe(20);
  expect(next.sessions.slice(1).every((s) => s.budget === 0)).toBe(true);
});

test('a repaired day off retains forfeited allocation through a later settings change', () => {
  const input = drawInput(at, { intent: testIntent({ daysOff: [2] }) }); // Tuesday, 2026-11-03
  const plan = drawDayPlan(input, { forfeited: 20 });
  expect(plan.volume).toMatchObject({ binding: 'day-off', planned: 0, forfeited: 20 });
  const resumed = replanRemainder(plan, { ...input, intent: testIntent() }, input.window.startsAt, NO_USAGE, 'repair');
  expect(resumed.volume.forfeited).toBe(20);
  expect(resumed.volume.planned).toBeLessThanOrEqual(resumed.ceilings.automaticMax - 20);
});

test.each([10, 30, 60])('an act-now Boost with a %i minute gap fits before quiet hours and day end', (minutes) => {
  const input = drawInput(at, { intent: testIntent({ operatingRate: 100, gapTargetOverrideMs: minutes * MS_PER_MINUTE,
    restDayProbability: 0, sessions: { min: 1, max: 1 } }) });
  const base = drawBase(input);
  for (let now = input.window.startsAt; now < input.window.endsAt; now += 15 * MS_PER_MINUTE) {
    const boost = { v: 1 as const, startedAt: now, endsAt: input.window.endsAt,
      durationMs: input.window.endsAt - now, endedAt: null, endReason: null };
    const out = applyBoost(base, { ...input, boost }, now, NO_USAGE);
    out.sessions.forEach((s, i) => {
      if (s.budget > 0 && !base.sessions.some((p) => p.startAt === s.startAt)) {
        expect(s.expectedEndAt).toBeLessThanOrEqual(closesAtOf(out, i, input.intent.quietHours));
      }
    });
    expect(out.volume.planned).toBeGreaterThanOrEqual(base.volume.planned);
    expect(out.volume.planned).toBeLessThanOrEqual(out.ceilings.automaticMax);
  }
});
