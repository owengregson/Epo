import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { launchStream } from '@/utils/entropy';
import { ADAPTER } from './config';
import { type Rng, sample, sleep } from './primitives';

/** The stream a retry pause draws from when its caller hands no rng. */
const retryDraws: Rng = launchStream('timing/page-retry');

/**
 * A fresh bounded pause before another navigation/click attempt (`pause.retry`): its band is relative
 * to the call site's retry wait, its floor the navigation poll. Correctness polls and deadlines stay
 * exact; abort remains immediate.
 */
export function pauseBeforePageRetry(
  baseMs: number,
  signal?: AbortSignal,
  rng: Rng = retryDraws,
  tempo?: TempoSource,
): Promise<void> {
  const policy = tempoOrReference(tempo).policy('pause.retry', { baseMs, pollMs: ADAPTER.NAV_SETTLE_MS });
  return sleep(sample(policy, rng), signal);
}
