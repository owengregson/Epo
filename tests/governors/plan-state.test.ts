/**
 * The persisted plan state (spec §16.3): a round trip is exact; a corrupt value reports why and keeps
 * its valid parts (a valid Boost window survives a repair); the legacy phase is migrated once; any
 * install with a ledger owes upgrade probation.
 */

import { PlanService } from '@/governors/plan-service';
import {
  initialPlanState,
  isDayPlan,
  migratedPhase,
  type PlanStateV1,
  parsePlanState,
  repairPlanState,
  serializePlanState,
} from '@/governors/plan-state';
import { drawDayPlan } from '@/kernel/plan/draw';
import { phaseOffsetHours } from '@/kernel/plan/seed';
import type { BoostWindow } from '@/kernel/plan/types';
import { drawInput, memoryPlanStore, planDeps } from '../kit/plan';

const plan = drawDayPlan(drawInput(new Date(2026, 10, 3, 12).getTime()));
const boost: BoostWindow = { v: 1, startedAt: 1_000, endsAt: 1_000 + 3_600_000, durationMs: 3_600_000, endedAt: null, endReason: null };
const state: PlanStateV1 = { v: 1, phaseOffsetHours: 0.4, plan, boost, upgradeProbation: true };

test('a round trip is exact', () => {
  const parsed = parsePlanState(serializePlanState(state));
  expect(parsed.problem).toBeNull();
  expect(parsed.state).toEqual(state);
  expect(isDayPlan(plan)).toBe(true);
});

test('a valid forfeiture survives serialization and a repair of another plan field', () => {
  const forfeited = 20;
  const charged = { ...state, phaseOffsetHours: 0, plan: { ...plan, volume: { ...plan.volume, forfeited } } };
  expect(parsePlanState(serializePlanState(charged)).state).toEqual(charged);
  const store = memoryPlanStore();
  const clock = { t: plan.window.startsAt };
  store.raw = JSON.stringify({ ...charged, plan: { ...charged.plan, kinds: null } });
  const repaired = new PlanService(planDeps(store, clock)).ensure();
  expect(repaired.plan.volume.forfeited).toBe(forfeited);
  expect(repaired.plan.volume.planned + forfeited).toBeLessThanOrEqual(repaired.plan.ceilings.automaticMax);
});

test('absent is not a problem', () => {
  expect(parsePlanState(null)).toMatchObject({ state: null, problem: null });
});

test.each([
  ['unreadable JSON', '{"v":1,'],
  ['not an object', '42'],
  ['a wrong version', JSON.stringify({ ...state, v: 2 })],
  ['a plan with a non-finite budget', JSON.stringify({ ...state, plan: { ...plan, sessions: [{ ...plan.sessions[0], budget: 'x' }] } })],
  ['a plan missing its window', JSON.stringify({ ...state, plan: { ...plan, window: null } })],
  ['a negative forfeiture', JSON.stringify({ ...state, plan: { ...plan, volume: { ...plan.volume, forfeited: -1 } } })],
])('%s is reported, never read as an empty plan', (_name, raw) => {
  const parsed = parsePlanState(raw);
  expect(parsed.state).toBeNull();
  expect(parsed.problem).not.toBeNull();
});

test('a repair keeps the valid phase and Boost window and re-derives the plan', () => {
  const corrupt = JSON.stringify({ ...state, plan: { ...plan, kinds: null } });
  const parsed = parsePlanState(corrupt);
  expect(parsed.boost).toEqual(boost);
  const repaired = repairPlanState(parsed, 0xabc);
  expect(repaired).toEqual({ v: 1, phaseOffsetHours: 0.4, plan: null, boost, upgradeProbation: true });
  const lost = repairPlanState(parsePlanState(JSON.stringify({ ...state, phaseOffsetHours: 'x', boost: { v: 9 } })), 0xabc);
  expect(lost.phaseOffsetHours).toBe(phaseOffsetHours(0xabc));
  expect(lost.boost).toBeNull();
});

test('the legacy phase is migrated once; a corrupt legacy value says so and falls back to the install phase', () => {
  expect(migratedPhase(JSON.stringify({ v: 1, phaseOffsetHours: -0.7 }), 5)).toEqual({ phase: -0.7, problem: null });
  expect(migratedPhase(null, 5)).toEqual({ phase: phaseOffsetHours(5), problem: null });
  const bad = migratedPhase('{oops', 5);
  expect(bad.phase).toBe(phaseOffsetHours(5));
  expect(bad.problem).toMatch(/unreadable/);
});

test('an install with a ledger owes upgrade probation; a fresh one does not', () => {
  expect(initialPlanState(0.2, true).upgradeProbation).toBe(true);
  expect(initialPlanState(0.2, false)).toEqual({ v: 1, phaseOffsetHours: 0.2, plan: null, boost: null, upgradeProbation: false });
});
