export type Rng = () => number;

export function unitRandom(rng: Rng): number {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Motion RNG must return a finite value in [0, 1]');
  }
  return value;
}

export function uniform(rng: Rng, min: number, max: number): number {
  return min + unitRandom(rng) * (max - min);
}

export function gaussian(rng: Rng): number {
  // The inclusive endpoint is useful for deterministic adversarial tests.
  const remaining = Math.max(Number.EPSILON, 1 - unitRandom(rng));
  return Math.sqrt(-2 * Math.log(remaining)) * Math.cos(2 * Math.PI * unitRandom(rng));
}
