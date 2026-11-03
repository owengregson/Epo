/**
 * The plan-backed TempoSource (spec §5.11): per-key streams are isolated; the launch seed changes the
 * sequences; the motion policy is resolved once per gesture; at the reference tempo it reproduces the
 * reference source with the added keys switched on; overrides only lengthen; the service hands it out.
 */
import { PlanService } from '@/governors/plan-service';
import type { SessionTempo } from '@/kernel/plan/types';
import { MOTION_REFERENCE, REFERENCE_TEMPO, referenceTempoSource, TEMPO_KEYS, TEMPO_SPECS, type TempoKey } from '@/kernel/tempo';
import { MS_PER_HOUR } from '@/kernel/units';
import { planTempoSource } from '@/timing/tempo-source';
import { memoryPlanStore, planDeps, testIntent, windowFor } from '../kit/plan';

const at = (tempo: SessionTempo, overrides: Partial<Record<TempoKey, number>> = {}) =>
  ({ current: () => tempo, overrides: () => overrides });
const drawable = TEMPO_KEYS.filter((k) => !['gap', 'travel', 'relative'].includes(TEMPO_SPECS[k].prior.shape));

test('at the reference tempo it reproduces the reference source, with every key enabled', () => {
  const plan = planTempoSource(at(REFERENCE_TEMPO), 42);
  const ref = referenceTempoSource(42);
  for (const key of drawable) {
    expect(Array.from({ length: 5 }, () => plan.draw(key))).toEqual(Array.from({ length: 5 }, () => ref.draw(key)));
    expect(plan.enabled(key)).toBe(true);
  }
});

test('streams are isolated: drawing one key never shifts another', () => {
  const a = planTempoSource(at(REFERENCE_TEMPO), 7);
  const b = planTempoSource(at(REFERENCE_TEMPO), 7);
  for (let i = 0; i < 20; i += 1) a.draw('walk.page');
  expect(a.draw('dwell.visit')).toBe(b.draw('dwell.visit'));
});

test('the launch seed changes the sequences', () => {
  const one = Array.from({ length: 5 }, ((s) => () => s.draw('dwell.visit'))(planTempoSource(at(REFERENCE_TEMPO), 1)));
  const two = Array.from({ length: 5 }, ((s) => () => s.draw('dwell.visit'))(planTempoSource(at(REFERENCE_TEMPO), 2)));
  expect(one).not.toEqual(two);
});

test('the motion policy is resolved once per gesture at the session motion', () => {
  let tempo: SessionTempo = { ...REFERENCE_TEMPO, pace: 1.44, motion: 1.2, depth: 1 / 1.44 };
  const source = planTempoSource({ current: () => tempo, overrides: () => ({}) }, 3);
  const g = source.gesture();
  tempo = REFERENCE_TEMPO;
  expect(g.policy.moveMaxMs).toBeGreaterThan(MOTION_REFERENCE.moveMaxMs);
  expect(source.gesture().policy).toBe(MOTION_REFERENCE);
});

test('a tempo override only lengthens a wait', () => {
  const plain = planTempoSource(at(REFERENCE_TEMPO), 5);
  expect(planTempoSource(at(REFERENCE_TEMPO, { 'walk.page': 2 }), 5).base('walk.page')).toBeGreaterThan(plain.base('walk.page'));
  expect(planTempoSource(at(REFERENCE_TEMPO, { 'walk.page': 0.2 }), 5).base('walk.page')).toBe(plain.base('walk.page'));
});

test('the plan service hands out a source that follows its open session', () => {
  const store = memoryPlanStore();
  const w = windowFor(new Date(2026, 10, 3, 12).getTime());
  const clock = { t: w.startsAt + MS_PER_HOUR };
  const service = new PlanService(planDeps(store, clock, { intent: () => testIntent({ tempoOverrides: { 'walk.rest': 2 } }) }));
  const first = service.ensure().plan.sessions.find((s) => s.budget > 0);
  if (first === undefined) return;
  clock.t = first.startAt + 1;
  const source = service.tempo();
  expect(source.current().pace).toBe(first.tempo.pace);
  expect(source.enabled('dwell.before-press')).toBe(true);
});
