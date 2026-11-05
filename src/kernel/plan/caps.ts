/**
 * The plan intent's derived caps (ADR 0607, spec §5.3): the unfollow hourly cap gains its consumer
 * (law L3), probation runs one caution rung down, cleanup is a share of the unfollow room, and
 * percentages become fractions here so no layer outside the kernel does unit arithmetic.
 * Layering: `src/kernel/**` imports nothing from the rest of `src/`.
 */

import { type Caution, SESSION } from '../derive';
import { EMPIRICAL } from '../fundamentals';
import { POLICY, PREFERENCES, SCALES } from '../policy';
import { MS_PER_SECOND } from '../units';
import type { GapShape } from './types';

const PERCENT = 100;

/** A percentage as a fraction. */
export function fromPercent(pct: number): number {
  return pct / PERCENT;
}

/** Unfollows per hour: the typical unfollow wall at the safety margin, scaled by caution (law L3). */
export function unfollowHourlyCap(caution: Caution): number {
  return Math.round(EMPIRICAL.UNFOLLOW_WALL_PER_HOUR.typical * POLICY.SAFETY_MARGIN * SCALES.caution[caution]);
}

/** The scale ratio one caution rung down; below Cautious the last ratio repeats (Bold→22, Standard→14, Cautious→9). */
function rungDownRatio(caution: Caution): number {
  const k = SCALES.caution;
  if (caution === 'bold') return k.standard / k.bold;
  return k.cautious / k.standard;
}

/** The hourly cap a probation session runs at: the live cap one caution rung down. */
export function probationHourlyCap(hourlyCap: number, caution: Caution): number {
  return Math.max(1, Math.round(hourlyCap * rungDownRatio(caution)));
}

/** The resolved cleanup fraction on the plan's room scale; defaults remain 0 · .36 · .71 and retired deep caps at steady. */
export function cleanupShare(fraction: number, weave: boolean): number {
  if (!weave) return 0;
  return Math.min(PREFERENCES.cleanup.steady.fraction, Math.max(0, fraction)) / PREFERENCES.cleanup.deep.fraction;
}

/** The reference gap shape at time-scale 1 for a rhythm median and a caution floor (seconds). */
export function referenceGapShape(medianSeconds: number, floorSeconds: number): GapShape {
  return {
    medianMs: medianSeconds * MS_PER_SECOND,
    sigma: SESSION.GAP_SIGMA,
    floorMs: floorSeconds * MS_PER_SECOND,
    capMs: SESSION.GAP_CAP_MS,
    hawkesAlpha: SESSION.HAWKES_ALPHA,
    hawkesTauMs: SESSION.HAWKES_TAU_MS,
  };
}
