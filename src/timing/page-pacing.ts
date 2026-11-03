import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { ADAPTER } from './config';
import { type Rng, sample, sleep } from './primitives';

/**
 * A fresh bounded pause before another navigation/click attempt (`pause.retry`): its band is relative
 * to the call site's retry wait, its floor the navigation poll. Correctness polls and deadlines stay
 * exact; abort remains immediate.
 */
export function pauseBeforePageRetry(
  baseMs: number,
  signal?: AbortSignal,
  rng: Rng = Math.random,
  tempo?: TempoSource,
): Promise<void> {
  const policy = tempoOrReference(tempo).policy('pause.retry', { baseMs, pollMs: ADAPTER.NAV_SETTLE_MS });
  return sleep(sample(policy, rng), signal);
}
