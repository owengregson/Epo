/**
 * Static-timing fixture: Math.random in each form it takes. Nothing imports it;
 * tests/tooling/no-static-timing.test.ts scans it and pins every key.
 */
export const draw = (): number => Math.random();
export const source: () => number = Math.random;

export function pick(rng?: () => number): number {
  return (rng ?? Math.random)();
}

const { random } = Math;
export const viaDestructuring = random;
