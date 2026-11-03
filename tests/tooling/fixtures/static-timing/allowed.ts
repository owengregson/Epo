/**
 * Static-timing fixture: values the gate allows, so a scan finds nothing here. Nothing imports it;
 * tests/tooling/no-static-timing.test.ts scans it.
 */

// Type positions are not values.
type Tier = 2 | 3;
export interface Panel {
  readonly width: 640;
  readonly tier: Tier;
}

// 0, 1 and -1.
export const NONE = 0;
export const ONE = 1;
export const BACK = -1;

// The kernel/units multipliers, used as multipliers or divisors.
export const toMs = (seconds: number): number => seconds * 1_000;
export const toMinutes = (ms: number): number => ms / 60_000;
export const toDays = (ms: number): number => (ms * 3_600_000) / 86_400_000;
export function stretch(ms: number): number {
  let out = ms;
  out *= 1000;
  return out;
}

// A property named `random` on another object is not Math.random.
export const other = { random: (): number => NONE }.random();
