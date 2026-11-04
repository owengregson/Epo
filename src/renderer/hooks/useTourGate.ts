import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { settingsViewSignal } from '@/renderer/app/shell-context';
import { appRevealedSignal } from '@/renderer/boot/BootGate';
import type { ToastControls } from '@/renderer/hooks/useToasts';
import { NEW_LOOK_STEPS, NEW_LOOK_VERSION, TOUR_STEPS, type TourStep } from '@/renderer/tour/steps';
import type { SettingsOp } from '@/shared/settings-ops';

export interface TourGate {
  open: boolean;
  steps: readonly TourStep[];
  openTour(): void;
  closeTour(): void;
}

/** First-run and new-look tours wait for the reveal; acknowledgments persist through v2 settings. */
export function useTourGate(onSettled: () => void, toast: ToastControls['push']): TourGate {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState(TOUR_STEPS);
  const autoChecked = useRef(false);

  const save = useCallback(async (ops: readonly SettingsOp[]): Promise<void> => {
    try {
      const result = await window.epo.applySettings(ops);
      if (result.kind !== 'saved') throw new Error('Tour progress was not saved');
      if (result.view.rev >= (settingsViewSignal.peek()?.rev ?? 0)) settingsViewSignal.value = result.view;
    } catch {
      toast('error', 'Epo couldn’t save your tour progress. It may offer the tour again next time.');
    }
  }, [toast]);

  const begin = useCallback((next: readonly TourStep[]): void => {
    setSteps(next);
    void window.epo.setTourHold(true).then(() => setOpen(true), () => {
      toast('error', 'Epo couldn’t pause for the tour. Try again from Settings.');
    });
  }, [toast]);

  useEffect(() => {
    const check = (): void => {
      const app = settingsViewSignal.peek()?.app;
      if (autoChecked.current || app === undefined || !appRevealedSignal.peek()) return;
      autoChecked.current = true;
      if (app.tourCompletedAt === null) begin(TOUR_STEPS);
      else if (app.tourVersionSeen !== NEW_LOOK_VERSION) {
        toast('info', 'Epo has a new look.', { label: 'Take the tour', run: () => begin(NEW_LOOK_STEPS) });
        void save([{ op: 'tour-version-seen', version: NEW_LOOK_VERSION }]);
      }
    };
    const offSettings = settingsViewSignal.subscribe(check);
    const offReveal = appRevealedSignal.subscribe(check);
    return () => { offSettings(); offReveal(); };
  }, [begin, save, toast]);

  const openTour = useCallback(() => begin(TOUR_STEPS), [begin]);
  const closeTour = useCallback(() => {
    setOpen(false);
    onSettled();
    void window.epo.setTourHold(false).catch(() => toast('error', 'Epo couldn’t release the tour pause. Restart Epo to continue.'));
    void save([
      { op: 'tour-completed', at: Date.now() },
      { op: 'tour-version-seen', version: NEW_LOOK_VERSION },
    ]);
  }, [onSettled, save, toast]);

  return { open, steps, openTour, closeTour };
}
