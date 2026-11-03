/**
 * The plan and Boost projections (spec §5.17, §8.5): totals and kinds as planned/done, the session
 * strip with pace words, the detail the plan really uses, `dayOff` only from the user's days off,
 * and the Boost states off / on / waiting / paused with the last end.
 */
import { projectBoost } from '@/governors/plan-boost';
import { projectPlan } from '@/governors/plan-projection';
import { viewPlan } from '@/governors/plan-view';
import { drawBase, drawDayPlan } from '@/kernel/plan/draw';
import type { BoostWindow } from '@/kernel/plan/types';
import { MS_PER_HOUR } from '@/kernel/units';
import { drawInput, noUse, testIntent, viewInputs } from '../kit/plan';

const NOON = new Date(2026, 10, 3, 12).getTime();
const input = drawInput(NOON);
const plan = drawBase(input);
const NO_READS = { profiles: 0, pages: 0, checks: 0 };

test('totals, kinds and the session strip mirror the plan and the ledger', () => {
  const now = input.window.startsAt + 12 * MS_PER_HOUR;
  const used = noUse({ all: 9, auto: 8, follow: 6, unfollow: 1, accept: 1, outside: 2 });
  const p = projectPlan(viewPlan(plan, viewInputs(plan, now, { used })), { profiles: 4, pages: 3, checks: 2 });
  expect(p.totals).toMatchObject({ planned: plan.volume.planned, done: 8, automaticMax: plan.ceilings.automaticMax, ceiling: plan.ceilings.day, outside: 2 });
  expect(p.kinds).toEqual({
    follow: { planned: plan.kinds.follow, done: 6 }, unfollow: { planned: plan.kinds.unfollow, done: 1 },
    accept: { planned: plan.kinds.accept, done: 1 },
  });
  expect(p.reads.profiles.done).toBe(4);
  expect(p.sessions).toHaveLength(plan.sessions.length);
  for (const s of p.sessions) expect(['relaxed', 'normal', 'quick']).toContain(s.pace);
  expect(p.detail.sessions[0].gap.timeScale).toBeGreaterThanOrEqual(1);
  expect(p.day.dayOff).toBe(false);
});

test('dayOff comes only from the user\'s own days off; a late open shows lateStart', () => {
  const off = drawBase(drawInput(NOON, { intent: testIntent({ daysOff: [new Date(input.window.startsAt).getDay() as 0] }) }));
  expect(projectPlan(viewPlan(off, viewInputs(off, NOON)), NO_READS).day.dayOff).toBe(true);
  const late = drawBase({ ...input, firstOpenAt: input.window.endsAt - MS_PER_HOUR });
  expect(projectPlan(viewPlan(late, viewInputs(late, input.window.endsAt - MS_PER_HOUR)), NO_READS).day.lateStart).toBe(true);
});

describe('the Boost view', () => {
  const at = input.window.startsAt + 9 * MS_PER_HOUR;
  const boost: BoostWindow = { v: 1, startedAt: at, endsAt: at + 4 * MS_PER_HOUR, durationMs: 4 * MS_PER_HOUR, endedAt: null, endReason: null };
  const boosted = drawDayPlan({ ...input, boost }, { now: at });

  test('off with no window, and the last end once one ended', () => {
    const v = viewPlan(plan, viewInputs(plan, at));
    expect(projectBoost(v, at, 'running', { record: null, followsDuring: null }).state).toBe('off');
    const ended = projectBoost(v, at, 'running', { record: { ...boost, endedAt: at + 1, endReason: 'user' }, followsDuring: 3 });
    expect(ended).toMatchObject({ state: 'off', lastEnded: { at: at + 1, reason: 'user' } });
  });

  test('paused while run intent is stopped; on or waiting while running', () => {
    const v = viewPlan(boosted, viewInputs(boosted, at, { boost }));
    expect(projectBoost(v, at, 'stopped', { record: boost, followsDuring: 0 }).state).toBe('paused');
    const running = projectBoost(v, at, 'running', { record: boost, followsDuring: 2 });
    expect(['on', 'waiting']).toContain(running.state);
    expect(running).toMatchObject({ startedAt: at, endsAt: at + 4 * MS_PER_HOUR, followsDuring: 2 });
    if (running.state === 'on') expect(running.effectiveFrom).toBe(at);
    else expect(running.effectiveFrom === null || (running.effectiveFrom ?? 0) > at).toBe(true);
  });
});
