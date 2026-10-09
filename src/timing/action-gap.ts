import { NOISE } from './config';
import { type DelayPolicy, jittered, uniform } from './primitives';

/**
 * Production action spacing. A collapsed positive range with jitter disabled
 * still gets bounded variation, always AFTER the configured interval. Existing
 * variable ranges retain their distribution and RNG order; zero waits used by
 * simulations remain zero. Callers persist the sampled deadline as usual.
 */
export function actionGap(minMs: number, maxMs: number, jitterPercent: number): DelayPolicy {
  if (minMs > 0 && minMs === maxMs && jitterPercent === 0) {
    return uniform(minMs, minMs * NOISE.BEAT_MAX_FACTOR);
  }
  return jittered(minMs, maxMs, jitterPercent);
}
