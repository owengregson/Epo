/**
 * The entropy root: outside the renderer every random draw starts here. Timing noise draws from
 * launch streams (mulberry32 over one launch seed per process); identifiers, the store's install
 * entropy and the dev harnesses take a fresh node:crypto draw.
 */
import { randomInt } from 'node:crypto';
import { fnv1a, mulberry32 } from '@/kernel/rng';

/** One draw is a 32-bit word, so every uniform lands on k / 2^32. */
const WORD = 0x1_0000_0000;

/** A fresh uniform draw in [0, 1) from node:crypto. */
export const cryptoUniform = (): number => randomInt(WORD) / WORD;

let seed: number | undefined;

/** The process's launch seed: one 32-bit node:crypto draw, taken at first use. */
export function launchSeed(): number {
  seed ??= randomInt(WORD);
  return seed;
}

const issued = new Map<string, number>();

/**
 * A uniform [0, 1) stream for one consumer, seeded at its first draw from the launch seed and the
 * label's n-th hash: two consumers never share a sequence, and nothing draws until one is needed.
 */
export function launchStream(label: string): () => number {
  let next: (() => number) | undefined;
  return () => {
    if (next === undefined) {
      const n = issued.get(label) ?? 0;
      issued.set(label, n + 1);
      next = mulberry32((fnv1a(`${label}#${n}`) ^ launchSeed()) >>> 0);
    }
    return next();
  };
}
