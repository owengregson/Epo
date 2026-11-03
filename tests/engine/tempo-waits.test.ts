/**
 * Engine and adapter waits read the injected tempo (ADR 0607, F2a step 3): the
 * reference tempo reproduces today's bases; a relaxed tempo lengthens a
 * pace-up base; the look-before-act pause is off at identity.
 */
import { lookBeforeActing } from '@/adapter/instagram-adapter';
import { acquisitionFailureBackoff } from '@/engine/target-recovery';
import { referenceTempoSource } from '@/kernel/tempo';
import { ENGINE } from '@/timing/config';
import { pauseBeforePageRetry } from '@/timing/page-pacing';
import { fixedTempo, recordingTempo } from '../kit/tempo';

const backoff = async (tempo: ReturnType<typeof referenceTempoSource> | undefined) => {
  const waits: Array<[string, unknown]> = [];
  await acquisitionFailureBackoff({
    tempo,
    wait: async (key, ms) => { waits.push([key, ms]); return { completed: true }; },
    recover: async () => 'idle',
  }, 'pk1', 'fetch-failed', new AbortController(), 0);
  return waits;
};

test('the acquisition backoff waits today\'s base at the reference tempo, and with no tempo at all', async () => {
  expect(await backoff(referenceTempoSource())).toEqual([['engine:enrich-backoff', ENGINE.ENRICH_BACKOFF_MS]]);
  expect(await backoff(undefined)).toEqual([['engine:enrich-backoff', ENGINE.ENRICH_BACKOFF_MS]]);
});

test('a relaxed tempo lengthens the walled backoff; it is never shorter than today\'s', async () => {
  const [[, relaxed]] = await backoff(fixedTempo(1.3));
  const [[, brisk]] = await backoff(fixedTempo(0.8));
  expect(relaxed).toBeGreaterThan(ENGINE.ENRICH_BACKOFF_MS);
  expect(brisk).toBe(ENGINE.ENRICH_BACKOFF_MS);
});

test('the page-retry pause asks for pause.retry with its call site\'s base', async () => {
  const tempo = recordingTempo();
  const stopped = AbortSignal.abort();
  await pauseBeforePageRetry(1_350, stopped, () => 0.5, tempo);
  expect(tempo.keys).toEqual(['pause.retry']);
});

describe('look before acting', () => {
  const run = async (tempo: ReturnType<typeof referenceTempoSource>) => {
    const calls: string[] = [];
    const pauses: number[] = [];
    const review = async (username: string): Promise<void> => { calls.push(`review:${username}`); };
    const wrapped = lookBeforeActing(review, tempo, undefined, async (ms) => { calls.push('pause'); pauses.push(ms); });
    await wrapped?.('jane', 'pk1', 'unfollow');
    return { calls, pauses };
  };

  test('off at identity: the reference tempo adds no pause after the review', async () => {
    expect(await run(referenceTempoSource())).toEqual({ calls: ['review:jane'], pauses: [] });
  });

  test('when enabled, one reading pause follows the review, inside the read band', async () => {
    const { calls, pauses } = await run(recordingTempo());
    expect(calls).toEqual(['review:jane', 'pause']);
    expect(pauses[0]).toBeGreaterThanOrEqual(2_500);
    expect(pauses[0]).toBeLessThanOrEqual(4_500);
  });

  test('no review, no wrapper', () => {
    expect(lookBeforeActing(undefined, referenceTempoSource())).toBeUndefined();
  });
});
