import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { adoptSettings, settingsSignal } from '@/renderer/app/shell-context';

/** Let the console's entrance animations land before dimming it. */
const AUTO_OPEN_DELAY_MS = 900;

export interface TourGate {
  open: boolean;
  /** Replay the tour from Settings → Data & session. */
  openTour(): void;
  /** Every close path — Finish, Skip, ×, Esc — routes here. */
  closeTour(): void;
}

/**
 * The intro tour's open/close policy. Auto-opens once per install (persisted
 * `tourCompletedAt`); any way out persists completion, so it never nags twice.
 *
 * The tour runs over a QUIET app: while it is open the foundation holds all
 * self-starting work and pauses a running engine. On FIRST launch main engages
 * that hold itself (before this renderer loads); a replay engages it here.
 * Every close path releases it, returning the app to its pre-tour state.
 *
 * Settings are read from {@link settingsSignal} (the shell's single load) and
 * the completion write is adopted back onto it. The subscription is
 * synchronous, so the one-shot check runs on the load that lands it — not a
 * frame later.
 *
 * @param onSettled runs on close, before the completion write: the shell uses
 *                  it to land on Overview + the Instagram tab (where login is).
 */
export function useTourGate(onSettled: () => void): TourGate {
  const [open, setOpen] = useState(false);
  const autoChecked = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = settingsSignal.subscribe((settings) => {
      if (settings === null || autoChecked.current) return;
      autoChecked.current = true;
      if (settings.tourCompletedAt !== null) return;
      timer.current = window.setTimeout(() => setOpen(true), AUTO_OPEN_DELAY_MS);
    });
    return () => {
      unsubscribe();
      if (timer.current !== null) window.clearTimeout(timer.current);
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
