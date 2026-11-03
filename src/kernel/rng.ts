/**
 * Seeded randomness the kernel's draws share. The kernel never reads an ambient
 * random source: every stream is mulberry32 over seed material (an install
 * entropy, a launch seed, a key hash), so a draw is reproducible from its inputs.
 * `src/timing/noise.ts` re-exports both functions for the timing layer.
 */

/** mulberry32: a small, fast 32-bit PRNG returning draws in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash: turns a key into mulberry32 seed material. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
