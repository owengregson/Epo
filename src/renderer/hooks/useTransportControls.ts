import { useCallback } from 'preact/hooks';
import { statusSignal, transportSignal } from '@/renderer/app/shell-context';
import type { ConfirmOptions } from '@/renderer/hooks/useConfirm';
import type { ControlRunner } from '@/renderer/hooks/useControl';

export interface TransportHandlers {
  onPauseResume(): void;
  onCancel(): Promise<void>;
  onLogin(): void;
}

/**
 * Unified transport routing: while a prune holds the tab, the same trio
 * pauses/resumes/stops the PRUNE — the growth engine is idle or parked
 * underneath, and driving it from here could only be refused by main. Which
 * driver owns the buttons comes from the one `transportModel`, so the routing
 * and the posture the buttons render can never disagree.
 *
 * The posture is read with `peek()` INSIDE each handler, at press time: these
 * callbacks are stable, and the shell never re-renders to keep them fresh.
 */
export function useTransportControls(
  control: ControlRunner,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  afterStop: () => void,
): TransportHandlers {
  const { run } = control;

  const onPauseResume = useCallback(() => {
    const transport = transportSignal.peek();
    if (transport.driver === 'prune') {
      const prunePaused = transport.state === 'paused';
      void run('pauseResume', prunePaused ? 'Resume' : 'Pause', () =>
        prunePaused ? window.epo.resumePrune() : window.epo.pausePrune(),
      );
      return;
    }
    const paused = statusSignal.peek()?.state === 'paused';
    void run('pauseResume', paused ? 'Resume' : 'Pause', () =>
      paused ? window.epo.resumeEngine() : window.epo.pauseEngine(),
    );
  }, [run]);

  const onCancel = useCallback(async (): Promise<void> => {
    const transport = transportSignal.peek();
    if (transport.driver === 'prune') {
      const { pruneScanning } = transport;
      const prunePaused = transport.state === 'paused';
      // Copy mirrors the prune page's own stop confirms (scan vs run).
      const ok = await confirm({
        title: pruneScanning ? 'Stop the scan?' : 'Stop the prune run?',
        body: pruneScanning
          ? 'The scan halts between scroll rounds — run it again any time for a fresh census.'
          : 'The accounts already unfollowed stay unfollowed; the rest stay runnable.',
        confirm: pruneScanning ? 'Stop scan' : 'Stop run',
        dismiss: prunePaused ? 'Keep paused' : pruneScanning ? 'Keep scanning' : 'Keep running',
        danger: true,
      });
      if (!ok) return;
      await run('stop', 'Stop prune', () => window.epo.stopPrune());
      return;
    }
    const ok = await confirm({
      title: 'Cancel the session?',
      body: 'Stops the engine between actions. Today’s action count is kept; pacing resumes where it left off.',
      confirm: 'Stop engine',
      dismiss: 'Keep running',
      danger: true,
    });
    if (!ok) return;
    await run('stop', 'Cancel', () => window.epo.stopEngine());
    afterStop();
  }, [confirm, run, afterStop]);

  const onLogin = useCallback(() => void run('login', 'Log in', () => window.epo.login()), [run]);

  return { onPauseResume, onCancel, onLogin };
}
