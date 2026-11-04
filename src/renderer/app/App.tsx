import { type JSX } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ConfirmHost } from '@/renderer/app/ConfirmHost';
import { liveRevealedSignal, liveSlotSignal } from '@/renderer/app/live-signals';
import { reducedMotionSignal } from '@/renderer/app/motion-signal';
import { PopoverHost } from '@/renderer/app/PopoverHost';
import { StageBar } from '@/renderer/app/StageBar';
import { StageHost } from '@/renderer/app/StageHost';
import {
  modalSignal,
  ShellContext,
  ShellControlsContext,
  type ShellServices,
  settingsTargetSignal,
  stageSignal,
} from '@/renderer/app/shell-context';
import { showStage, useProvideShellControls } from '@/renderer/app/shell-services';
import { TooltipHost } from '@/renderer/app/TooltipHost';
import { GraphStage } from '@/renderer/graph/GraphStage';
import { useConfirm } from '@/renderer/hooks/useConfirm';
import { useControl } from '@/renderer/hooks/useControl';
import { useEngineStatus } from '@/renderer/hooks/useEngineStatus';
import { useGraphBoard } from '@/renderer/hooks/useGraphBoard';
import { useLiveFeeds } from '@/renderer/hooks/useLiveFeeds';
import { usePruneStatus } from '@/renderer/hooks/usePruneStatus';
import { useSettings } from '@/renderer/hooks/useSettings';
import { useStageRequest } from '@/renderer/hooks/useStageRequest';
import { useToasts } from '@/renderer/hooks/useToasts';
import { useTourGate } from '@/renderer/hooks/useTourGate';
import { useUpdateStatus } from '@/renderer/hooks/useUpdateStatus';
import { useUpdateToasts } from '@/renderer/hooks/useUpdateToasts';
import { PeoplePage } from '@/renderer/pages/PeoplePage';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { Sidebar } from '@/renderer/sidebar/Sidebar';
import { Tour } from '@/renderer/tour/Tour';
import { PruneView } from '@/renderer/views/PruneView';

/** The interim Settings stage's navigation: the old console views map onto stages. */
const VIEW_STAGE = { overview: 'tab', chain: 'people', queues: 'people', settings: 'settings' } as const;

/**
 * The dashboard shell (spec §12.4, ADR 1010): the console column on the left,
 * the stage bar and five stages on the right — Live (Instagram, with a slot
 * beneath it for the boot placeholder), People, Graph (laid out from the first
 * frame), Prune, and Settings (mounted the first time it opens). It owns every
 * shell subscription once, the toast, confirm, tooltip and tour layers, and the
 * stage request to main: `setStage(stage, modalOpen || !liveRevealed)`.
 */
export function App(): JSX.Element {
  // The shell's single subscription points: they publish to signals and return
  // nothing, so a push re-renders only the components that read it.
  useEngineStatus();
  usePruneStatus();
  useSettings();
  useLiveFeeds();

  const toasts = useToasts();
  const confirmCtl = useConfirm();
  const updateStatus = useUpdateStatus();
  const control = useControl(toasts.push);
  const tour = useTourGate(useCallback(() => showStage('tab'), []), toasts.push);
  const reducedMotion = reducedMotionSignal.value;
  // Both are stable callbacks, so the services object is built once.
  const services = useMemo<ShellServices>(
    () => ({ confirm: confirmCtl.confirm, toast: toasts.push }),
    [confirmCtl.confirm, toasts.push],
  );
  const controls = useProvideShellControls({ confirm: confirmCtl.confirm, control, replayTour: tour.openTour });

  const stage = stageSignal.value;
  const graphBoard = useGraphBoard(stage === 'graph');
  // The native tab and its veil float above anything this page draws, so an open
  // confirm asks main to cover them; so does the boot gate until its reveal.
  const modalOpen = confirmCtl.state.open;
  const revealed = liveRevealedSignal.value;
  useEffect(() => {
    modalSignal.value = modalOpen;
    void window.epo.setStage(stage, modalOpen || !revealed, reducedMotion);
  }, [stage, modalOpen, revealed, reducedMotion]);

  useStageRequest(showStage, !tour.open);
  useUpdateToasts(updateStatus, tour.open, toasts.push);

  // The interim Settings stage focuses its starting-account field on a bumped prompt.
  const [seedPrompt, setSeedPrompt] = useState(0);
  useEffect(
    () =>
      settingsTargetSignal.subscribe((target) => {
        if (target?.focus === 'seed') setSeedPrompt((n) => n + 1);
      }),
    [],
  );

  return (
    <ShellContext.Provider value={services}>
      <ShellControlsContext.Provider value={controls}>
      <div class="shell">
        {/* The live column: its zones are the tour's anchors, its toasts dock above its footer. */}
        <Sidebar toasts={toasts} update={updateStatus} />
        <div class="stagepane">
          <StageBar stage={stage} onSelect={showStage} graphCount={graphBoard.snapshot?.pks.length ?? null} />
          <div class="stagepane-body" data-tour="stagebody">
            <StageHost mode="tab" active={stage === 'tab'} mount="eager">
              {liveSlotSignal.value}
            </StageHost>
            <StageHost mode="people" active={stage === 'people'} mount="on-activation">
              <PeoplePage />
            </StageHost>
            <StageHost mode="graph" active={stage === 'graph'} mount="eager">
              <GraphStage board={graphBoard} active={stage === 'graph'} />
            </StageHost>
            <StageHost mode="prune" active={stage === 'prune'} mount="on-activation">
              <PruneView />
            </StageHost>
            <StageHost mode="settings" active={stage === 'settings'} mount="lazy">
              <SettingsStage
                goTo={(view) => showStage(VIEW_STAGE[view])}
                seedPrompt={seedPrompt}
                onReplayTour={tour.openTour}
                updateStatus={updateStatus}
              />
            </StageHost>
          </div>
        </div>
        {/* Shell-level layers: outside .console (whose overflow would clip them),
            so a tooltip, a popover, a confirm's scrim or the tour covers the whole window. */}
        <TooltipHost />
        <PopoverHost />
        <ConfirmHost {...confirmCtl.state} onClose={confirmCtl.close} />
        <Tour steps={tour.steps} open={tour.open} onClose={tour.closeTour} setStage={showStage} />
      </div>
      </ShellControlsContext.Provider>
    </ShellContext.Provider>
  );
}
