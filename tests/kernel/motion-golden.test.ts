/**
 * The MOTION golden (ADR 0607, spec §5.12 item 4): the table equals the frozen
 * snapshot plus the ADDED ledger, every key has exactly one role, every shape
 * dial carries a guard line and provenance, and `deriveMotion` is the identity
 * at m = 1 and moves only what the roles say it may.
 */
import fc from 'fast-check';
import { MOTION } from '@/kernel/motion-policy';
import { MOTION_ADDED, MOTION_ROLE, MOTION_SHAPE_DIALS, type MotionRole } from '@/kernel/motion-roles';
import { deriveMotion, MOTION_REFERENCE, type MotionPolicy } from '@/kernel/tempo/motion';
import { MOTION_SNAPSHOT } from './motion.snapshot';

type Key = keyof typeof MOTION;
const KEYS = Object.keys(MOTION) as Key[];
const roleOf = (k: Key): MotionRole => MOTION_ROLE[k];
const keysWith = (role: MotionRole): Key[] => KEYS.filter((k) => roleOf(k) === role);
const values = (p: MotionPolicy, k: Key): number[] => {
  const v = p[k];
  return typeof v === 'number' ? [v] : [...v];
};
/** The motion factor's range over the pace band [0.7, 1.45] at elasticity ½, widened for margin. */
const motionFactor = fc.double({ min: 0.5, max: 2, noNaN: true });

describe('MOTION snapshot ⊕ ADDED', () => {
  test('the snapshot is the pre-registry table: 61 keys', () => {
    expect(Object.keys(MOTION_SNAPSHOT)).toHaveLength(61);
  });

  test('MOTION equals the frozen snapshot plus the ADDED ledger, exactly', () => {
    const added = Object.fromEntries(Object.entries(MOTION_ADDED).map(([k, e]) => [k, e.value]));
    for (const k of Object.keys(MOTION_ADDED)) expect(Object.keys(MOTION_SNAPSHOT)).not.toContain(k);
    expect(MOTION).toEqual({ ...MOTION_SNAPSHOT, ...added });
  });

  test('every ADDED entry names the literal it replaced and the ADR', () => {
    for (const entry of Object.values(MOTION_ADDED)) {
      expect(entry.from.length).toBeGreaterThan(10);
      expect(entry.adr).toBe('0607');
    }
  });
});

describe('MOTION_ROLE coverage', () => {
  test('every MOTION key has exactly one role, and no role names a missing key', () => {
    expect(Object.keys(MOTION_ROLE).sort()).toEqual([...KEYS].sort());
  });

  test('every shape dial has a guard line and provenance; nothing else is listed', () => {
    expect(Object.keys(MOTION_SHAPE_DIALS).sort()).toEqual(keysWith('shape').sort());
    for (const dial of Object.values(MOTION_SHAPE_DIALS)) {
      expect(dial.guard.length).toBeGreaterThan(10);
      expect(dial.guard.length).toBeLessThanOrEqual(100);
      expect(dial.provenance.length).toBeGreaterThan(10);
    }
  });

  test('the speed–accuracy keys are exactly the five the spec names', () => {
    expect(keysWith('speed-accuracy').sort()).toEqual([
      'overshootFraction', 'overshootProbability', 'targetSigmaFraction',
      'wheelOvershootFraction', 'wheelOvershootProbability',
    ]);
  });
});

describe('deriveMotion', () => {
  test('identity at m = 1: MOTION_REFERENCE is MOTION and deriveMotion(1) equals it', () => {
    expect(MOTION_REFERENCE).toBe(MOTION);
    expect(deriveMotion(1)).toEqual(MOTION_REFERENCE);
  });

  test('shape, guardrail and device keys are identical at every motion factor', () => {
    const fixed = [...keysWith('shape'), ...keysWith('guardrail'), ...keysWith('device')];
    fc.assert(fc.property(motionFactor, (m) => {
      const p = deriveMotion(m);
      for (const k of fixed) expect(p[k]).toEqual(MOTION[k]);
    }));
  });

  test('speed–accuracy keys never increase with the motion factor and stay within [0, 1]', () => {
    fc.assert(fc.property(motionFactor, motionFactor, (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const slow = deriveMotion(hi);
      const brisk = deriveMotion(lo);
      for (const k of keysWith('speed-accuracy')) {
        values(slow, k).forEach((v, i) => {
          expect(v).toBeLessThanOrEqual(values(brisk, k)[i] + 1e-12);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        });
      }
    }));
  });

  test('tempo durations never fall below their floor and never shrink as m grows', () => {
    fc.assert(fc.property(motionFactor, motionFactor, (a, b) => {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const short = deriveMotion(lo);
      const long = deriveMotion(hi);
      for (const k of ['pressMs', 'hoverSettleMs', 'prePressMs', 'wheelPauseMs', 'wheelMicroPauseMs',
        'wheelCorrectionPauseMs'] as const) {
        expect(short[k][0]).toBe(MOTION[k][0]);
        expect(short[k][1]).toBeGreaterThanOrEqual(MOTION[k][0]);
        expect(long[k][1]).toBeGreaterThanOrEqual(short[k][1]);
      }
      expect(short.moveMinMs).toBe(MOTION.moveMinMs);
      expect(long.moveMaxMs).toBeGreaterThanOrEqual(short.moveMaxMs);
      expect(short.pressMedianMs).toBeGreaterThanOrEqual(MOTION.pressMs[0]);
    }));
  });

  test('the pace-axis dwell keys are not motion durations: deriveMotion leaves them alone', () => {
    const p = deriveMotion(1.2);
    expect(p.profileDwellMs).toEqual(MOTION.profileDwellMs);
    expect(p.profileDwellMedianMs).toBe(MOTION.profileDwellMedianMs);
  });
});
