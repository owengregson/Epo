import { PATTERN } from './config';

/**
 * Deterministic small PRNG (mulberry32). Seeded — NOT Math.random — because the
 * plan must be a property of the cycle: a restart mid-cycle re-derives the same
 * number instead of rerolling a target the engine already stopped at.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The planned volume for one active-hours cycle: a draw uniformly in
 * [CYCLE_PLAN_MIN_FRACTION, CYCLE_PLAN_MAX_FRACTION] × `cap`, seeded by the
 * cycle start and the cap itself — the same cycle always plans the same
 * number (restart-safe), a new cycle or a changed cap redraws, and different
 * caps (growth vs prune) draw independently. For caps ≥ CYCLE_PLAN_MIN_CAP the
 * plan is strictly under the cap: the cap stays the uncrossable limit, the
 * plan is where a normal day actually stops. Tiny caps pass through unchanged.
 */
export function cyclePlan(cap: number, cycleStartMs: number): number {
  if (cap < PATTERN.CYCLE_PLAN_MIN_CAP) return Math.max(1, Math.round(cap));
  // Mix the cycle (minute resolution keeps it inside 32 bits) with the cap.
  const seed = Math.imul(Math.floor(cycleStartMs / 60_000) >>> 0, 0x9e3779b1) ^ Math.imul(cap, 0x85ebca6b);
  const u = mulberry32(seed)();
  const { CYCLE_PLAN_MIN_FRACTION: lo, CYCLE_PLAN_MAX_FRACTION: hi } = PATTERN;
  const plan = Math.round(cap * (lo + u * (hi - lo)));
  return Math.min(cap - 1, Math.max(1, plan));
}
