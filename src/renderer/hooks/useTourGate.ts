import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { adoptSettings, settingsSignal } from '@/renderer/app/shell-context';
import { appRevealedSignal } from '@/renderer/boot/BootGate';

export interface TourGate {
  open: boolean;
  /** Replay the tour from Settings. */
  openTour(): void;
  /** Every close path — Finish, Skip, ×, Esc — routes here. */
  closeTour(): void;
}

/**
 * The intro tour's open/close policy. Auto-opens once per install (persisted
 * `tourCompletedAt`), right after the launch reveal — never under the splash or
 * during the intro (spec §12.8, the tour keys on the reveal). Any way out
 * persists completion, so it never nags twice.
 *
 * The tour runs over a QUIET app: while it is open the foundation holds all
 * self-starting work and pauses a running engine. On FIRST launch main engages
 * that hold itself (before this renderer loads); a replay engages it here.
 * Every close path releases it, returning the app to its pre-tour state.
 *
 * @param onSettled runs on close, before the completion write: the shell uses
 *                  it to land on the Live stage (where sign-in is).
 */
export function useTourGate(onSettled: () => void): TourGate {
  const [open, setOpen] = useState(false);
  const autoChecked = useRef(false);

  useEffect(() => {
    // Both are signals: the check runs on whichever lands last, the settings load or the reveal.
    const check = (): void => {
      const settings = settingsSignal.peek();
      if (autoChecked.current || settings === null || !appRevealedSignal.peek()) return;
      autoChecked.current = true;
      if (settings.tourCompletedAt === null) setOpen(true);
    };
    const offSettings = settingsSignal.subscribe(check);
    const offReveal = appRevealedSignal.subscribe(check);
    return () => {
      offSettings();
      offReveal();
    };
  }, []);

  const openTour = useCallback(() => {
    void window.epo.setTourHold(true);
    setOpen(true);
  }, []);

  const closeTour = useCallback(() => {
    setOpen(false);
    onSettled();
    void window.epo.setTourHold(false);
    window.epo
      .updateSettings({ tourCompletedAt: Date.now() })
      .then(adoptSettings)
      .catch(() => {
        /* foundation logs; worst case the tour offers itself again next launch */
      });
  }, [onSettled]);

  return { open, openTour, closeTour };
}
