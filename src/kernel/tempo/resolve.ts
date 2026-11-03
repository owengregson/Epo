/**
 * Resolving a tempo spec at a session tempo (ADR 0607, spec §5.11).
 *
 * `scaleAbove` is the one scaling rule: a value moves away from its floor by the
 * factor, so it is the identity at f = 1 and never crosses the floor for f ≥ 0.
 */

/** `floor + (value − floor) × factor`: identity at 1, never below the floor for factor ≥ 0. */
export function scaleAbove(value: number, floor: number, factor: number): number {
  return floor + (value - floor) * factor;
}
