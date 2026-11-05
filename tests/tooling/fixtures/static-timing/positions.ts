/**
 * Static-timing fixture: a numeric literal in each syntactic position the gate covers. Nothing
 * imports it; tests/tooling/no-static-timing.test.ts scans it and pins every key.
 */

// Object-literal properties, nested ones included: today's ACQUISITION_DEFAULTS and READ_RETRY shapes.
export const ACQUISITION_DEFAULTS = { maxCoverageFraction: 0.5, targetNewPks: 100 };
export const EFFECT_POLICY = { READ_RETRY: { base: 2_000, cap: 30_000 } };

// A top-level const, array elements, a default parameter.
export const RETRY_LIMIT = 7;
export const STEPS_MS = [250, 500];
export function retryAfter(waitMs = 1_500): number {
  return waitMs;
}

// A class field, a local const, call arguments, an arithmetic operand, a unit value outside a product.
export class Pacer {
  private readonly restMs = 400;

  pause(sleep: (ms: number) => void): void {
    const settleMs = 300;
    sleep(settleMs);
    sleep(2_500);
    sleep(this.restMs * 3);
    sleep(60_000);
  }
}

// A comparison operand and a negative returned value.
export function clampStep(step: number): number {
  if (step > 12) return -4;
  return step;
}
