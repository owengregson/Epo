import { noisify } from './noise';
import { type Rng, sample, sleep } from './primitives';

/**
 * A fresh bounded pause between page attempts. Correctness polls and deadlines
 * stay exact; this pause controls when another navigation/click may be attempted.
 * The existing sub-cadence policy supplies the band and abort remains immediate.
 */
export function pauseBeforePageRetry(
  baseMs: number,
  signal?: AbortSignal,
  rng: Rng = Math.random,
): Promise<void> {
  return sleep(sample(noisify('sub-cadence', baseMs, rng)), signal);
}
