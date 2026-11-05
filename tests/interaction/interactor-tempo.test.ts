/**
 * The Interactor resolves its motion policy from the injected tempo, once per
 * gesture: the pre-press beat, the hover settle, the drift and the initial
 * cursor all read that policy (ADR 0607, F2a step 3).
 */
import type { InputDriver } from '@/interaction/input-driver';
import { Interactor } from '@/interaction/interactor';
import { MOTION_REFERENCE, type MotionPolicy, referenceTempoSource, type TempoSource } from '@/kernel/tempo';

const quietDriver: InputDriver = { mouseMove() {}, mouseDown() {}, mouseUp() {}, wheel() {} };
const TARGET = { x: 500, y: 300, width: 140, height: 44 };

/** A tempo whose gestures carry `policy`, counting how often a gesture resolved it. */
const tempoWith = (policy: MotionPolicy): TempoSource & { gestures: number } => {
  const base = referenceTempoSource();
  const t = { ...base, gestures: 0, gesture: () => { t.gestures += 1; return { policy, rng: () => 0.5 }; } };
  return t;
};

const build = (tempo: TempoSource) => {
  const sleeps: number[] = [];
  let i = 0;
  const h = new Interactor({ driver: quietDriver, rng: () => [0.31, 0.62, 0.17, 0.83, 0.46][i++ % 5], tempo,
    sleep: async (ms) => { sleeps.push(ms); } });
  return { h, sleeps };
};

test('the pre-press beat and the hover settle come from the gesture policy', async () => {
  const policy: MotionPolicy = { ...MOTION_REFERENCE, prePressMs: [77, 77], hoverSettleMs: [333, 333] };
  const tempo = tempoWith(policy);
  const { h, sleeps } = build(tempo);
  await h.hover(TARGET);
  expect(sleeps.at(-1)).toBe(333);
  await h.click(TARGET);
  expect(sleeps).toContain(77);
});

test('the initial cursor is drawn from the policy bands before any gesture', () => {
  const policy: MotionPolicy = { ...MOTION_REFERENCE, initialCursorXPx: [42, 42], initialCursorYPx: [24, 24] };
  const { h } = build(tempoWith(policy));
  expect(h.position()).toEqual({ x: 42, y: 24 });
});

test('the policy is resolved once per gesture (plus once for the initial cursor)', async () => {
  const tempo = tempoWith(MOTION_REFERENCE);
  const { h } = build(tempo);
  expect(tempo.gestures).toBe(1);
  await h.hover(TARGET);
  await h.click(TARGET);
  expect(tempo.gestures).toBe(3);
});
