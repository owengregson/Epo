/**
 * Law L10 (spec §5.9, §5.11): session factors stay in the beat band; motion = pace^½; depth = 1/pace;
 * the pace spread follows consistency (.128 Typical, .055 Even, .207 Varied); shape motion keys never
 * move; speed–accuracy keys fall with motion inside their guardrails; pace-up waits never shorten.
 */
import fc from 'fast-check';
import { MOTION } from '@/kernel/motion-policy';
import { MOTION_ROLE } from '@/kernel/motion-roles';
import { planSeed } from '@/kernel/plan/seed';
import { ambientTempo, paceAt, paceSigma, sessionLatent, sessionTempo } from '@/kernel/plan/tempo';
import { SCALES } from '@/kernel/policy';
import { deriveMotion, locationOf, priorMin, resolve, TEMPO_SPECS, type TempoKey } from '@/kernel/tempo';
import { testIntent } from '../../kit/plan';

const seedArb = fc.integer({ min: 0, max: 0xffffffff }).map((e) => planSeed(e, '2026-11-03'));
const intent = testIntent();

describe('the pace draw', () => {
  test('σ_pace per consistency: .128 Typical, .055 Even, .207 Varied', () => {
    expect(paceSigma(SCALES.consistency.natural)).toBeCloseTo(0.128, 3);
    expect(paceSigma(SCALES.consistency.clockwork)).toBeCloseTo(0.055, 3);
    expect(paceSigma(SCALES.consistency.erratic)).toBeCloseTo(0.207, 3);
  });

  test('L10: every factor stays in [0.7, 1.45]; motion = pace^½; depth = 1/pace; τ ≥ 1', () => {
    fc.assert(fc.property(seedArb, fc.integer({ min: 0, max: 8 }), fc.constantFrom(0.43, 1, 1.61), fc.boolean(), fc.boolean(),
      (seed, s, k, boost, probation) => {
        const t = sessionTempo(seed, s, testIntent({ consistencyScale: k }), { mix: boost ? 'boost' : 'normal', probation },
          intent.hourlyCap, 8);
        return t.pace >= 0.7 && t.pace <= 1.45 && Math.abs(t.motion - Math.sqrt(t.pace)) < 1e-12
          && Math.abs(t.depth * t.pace - 1) < 1e-12 && t.gap.timeScale >= 1 && t.mix === (boost ? 'boost' : 'normal')
          && t.probation === probation;
      }), { numRuns: 60 });
  });

  test('day and session latents combine to unit variance; the ambient tempo is the day latent', () => {
    const zs = Array.from({ length: 4000 }, (_, i) => sessionLatent(planSeed(i, 'k'), i % 7));
    const m = zs.reduce((a, b) => a + b, 0) / zs.length;
    const v = zs.reduce((a, b) => a + (b - m) ** 2, 0) / zs.length;
    expect(Math.abs(v - 1)).toBeLessThan(0.08);
    const seed = planSeed(5, '2026-11-03');
    expect(ambientTempo(seed, intent, 8).pace).toBe(paceAt(ambientTempo(seed, intent, 8).z, intent.consistencyScale));
  });

  test('probation paces the gap against the probation cap: a slower target at the same pace', () => {
    const seed = planSeed(9, '2026-11-03');
    const normal = sessionTempo(seed, 1, intent, { mix: 'normal', probation: false }, intent.hourlyCap, 8);
    const gentle = sessionTempo(seed, 1, intent, { mix: 'normal', probation: true }, intent.hourlyCap, 8);
    expect(gentle.pace).toBe(normal.pace);
    expect(gentle.gap.targetMeanMs).toBeGreaterThan(normal.gap.targetMeanMs);
  });

  test('Boost never changes tempo', () => {
    const seed = planSeed(11, '2026-11-03');
    const a = sessionTempo(seed, 2, intent, { mix: 'normal', probation: false }, intent.hourlyCap, 8);
    const b = sessionTempo(seed, 2, intent, { mix: 'boost', probation: false }, intent.hourlyCap, 8);
    expect({ ...b, mix: 'normal' }).toEqual(a);
  });
});

describe('L10 over the registry at drawn tempos', () => {
  const tempos = Array.from({ length: 40 }, (_, i) =>
    sessionTempo(planSeed(i * 7919, '2026-11-03'), i % 6, testIntent({ consistencyScale: 1.61 }), { mix: 'normal', probation: false },
      intent.hourlyCap, 8));
  const keys = Object.keys(TEMPO_SPECS) as TempoKey[];

  test('scaleAbove never crosses a floor, at any override factor', () => {
    for (const t of tempos) {
      for (const key of keys) {
        // Viewport depths take their px floor at the call site; gap, travel and relative priors resolve elsewhere.
        if (['gap', 'travel', 'relative', 'scale'].includes(TEMPO_SPECS[key].prior.shape)) continue;
        for (const f of [1, 2, 3]) {
          const r = resolve(key, t, f);
          expect(priorMin(r.prior, t)).toBeGreaterThanOrEqual(r.floorValue - 1e-9);
        }
      }
    }
  });

  test('every pace-up key is at least its prior at every tempo and override', () => {
    for (const t of tempos) {
      for (const key of ['park.blocked', 'backoff.walled', 'beat.transient'] as const) {
        const prior = (TEMPO_SPECS[key].prior as { value: number }).value;
        for (const f of [1, 1.5, 3]) expect(locationOf(resolve(key, t, f))).toBeGreaterThanOrEqual(prior);
      }
    }
  });

  test('shape motion keys are identical at every drawn motion; speed–accuracy keys fall with motion within guardrails', () => {
    const sorted = [...tempos].sort((a, b) => a.motion - b.motion);
    let prev: ReturnType<typeof deriveMotion> | null = null;
    for (const t of sorted) {
      const p = deriveMotion(t.motion);
      for (const [key, role] of Object.entries(MOTION_ROLE)) {
        if (role === 'shape' || role === 'guardrail' || role === 'device') {
          expect(p[key as keyof typeof MOTION]).toEqual(MOTION[key as keyof typeof MOTION]);
        }
      }
      if (prev !== null) {
        expect(p.overshootProbability).toBeLessThanOrEqual(prev.overshootProbability + 1e-12);
        expect(p.targetSigmaFraction).toBeLessThanOrEqual(prev.targetSigmaFraction + 1e-12);
      }
      expect(p.overshootProbability).toBeLessThanOrEqual(1);
      expect(p.targetSigmaFraction).toBeLessThanOrEqual(0.5);
      prev = p;
    }
  });
});
