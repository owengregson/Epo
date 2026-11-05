/** Observe an existing action pause without drawing again or changing its cancellation semantics. */
import type { SleepFn } from '@/timing/primitives';
import * as logger from '@/utils/logger';

export async function actionPause(phase: 'dwell.before-press' | 'ui.step-pause', requestedMs: number,
  pause: SleepFn, signal: AbortSignal | undefined,
  context: { op: string; username: string; layer?: string; later?: boolean }): Promise<void> {
  const started = performance.now();
  const at = Date.now();
  logger.info('action: pause requested', { ...context, phase, requestedMs, at });
  let fulfilled = false;
  try {
    await pause(requestedMs, signal);
    fulfilled = true;
  } finally {
    logger.info('action: pause finished', { ...context, phase, requestedMs, at: Date.now(),
      elapsedMs: performance.now() - started,
      outcome: !fulfilled ? 'error' : signal?.aborted ? 'aborted' : 'completed' });
  }
}
