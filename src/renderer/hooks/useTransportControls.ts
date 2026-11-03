import { useCallback } from 'preact/hooks';
import { pruneSignal, statusSignal } from '@/renderer/app/shell-context';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { ControlRunner } from '@/renderer/hooks/useControl';
import { postureSignal } from '@/renderer/sidebar/posture-signal';

export interface TransportHandlers {
  onPauseResume(): void;
  onCancel(): Promise<void>;
  onLogin(): void;
}

/** Stop's toast (spec C.15.1, owner Q29): Stop is not destructive, Start resumes today's plan. */
export const STOP_TOAST = 'Stopped. Today’s progress is kept.';
export const UNDO = 'Undo';

/**
 * Unified transport routing (spec §12.3): which driver the buttons control comes from the one posture, so
 * the routing and the buttons can never disagree — while a prune holds the page the same controls pause,
 * resume and stop the PRUNE. Resume calls `startEngine` when the engine is idle (a pause kept across a
 * restart). Stop has no confirm: an Undo toast starts Epo again. Stopping a prune scan or run still asks,
 * because a stopped scan cannot pick up where it was.
 *
 * Everything is read with `peek()` inside each handler, at press time: the callbacks are stable.
 */
export function useTransportControls(
  control: ControlRunner,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  afterStop: () => void,
): TransportHandlers {
  const { run, toast } = control;

  const onPauseResume = useCallback(() => {
    if (postureSignal.peek().driver === 'prune') {
      const prunePaused = pruneSignal.peek()?.state === 'paused';
      void run('pauseResume', prunePaused ? 'Resume' : 'Pause', () =>
        prunePaused ? window.epo.resumePrune() : window.epo.pausePrune(),
      );
      return;
    }
    const state = statusSignal.peek()?.state;
    if (postureSignal.peek().kind === 'paused' && state === 'idle') {
      void run('start', 'Resume', () => window.epo.startEngine());
      return;
    }
    void run('pauseResume', state === 'paused' ? 'Resume' : 'Pause', () =>
      state === 'paused' ? window.epo.resumeEngine() : window.epo.pauseEngine(),
    );
  }, [run]);

  const onCancel = useCallback(async (): Promise<void> => {
    if (postureSignal.peek().driver === 'prune') {
      const prune = pruneSignal.peek();
      const scanning = prune?.state === 'scanning';
      const ok = await confirm({
        title: scanning ? 'Stop checking?' : 'Stop pruning?',
        body: scanning
          ? 'The check stops between pages. Run it again any time for a fresh one.'
          : 'People already unfollowed stay unfollowed; the rest stay ready for the next prune.',
        confirm: scanning ? 'Stop checking' : 'Stop pruning',
        dismiss: prune?.state === 'paused' ? 'Keep paused' : scanning ? 'Keep checking' : 'Keep pruning',
        danger: true,
      });
      if (!ok) return;
      await run('stop', 'Stop', () => window.epo.stopPrune());
      return;
    }
    await run('stop', 'Stop', () => window.epo.stopEngine());
    toast('info', STOP_TOAST, { label: UNDO, run: () => void run('start', 'Start', () => window.epo.startEngine()) });
    afterStop();
  }, [confirm, run, toast, afterStop]);

  const onLogin = useCallback(() => void run('login', 'Sign in', () => window.epo.login()), [run]);

  return { onPauseResume, onCancel, onLogin };
}
