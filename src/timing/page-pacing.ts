import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { ADAPTER } from './config';
import { type Rng, sample, sleep } from './primitives';

/**
 * A fresh bounded pause between page attempts (`pause.retry`). Correctness
 * polls and deadlines stay exact; this pause controls when another
 * navigation/click may be attempted, and abort remains immediate. The band is
 * relative to the call site's own retry wait; its floor is the navigation poll.
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
