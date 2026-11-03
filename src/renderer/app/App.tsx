import { type JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ConfirmHost } from '@/renderer/app/ConfirmHost';
import { Header } from '@/renderer/app/Header';
import { Nav } from '@/renderer/app/Nav';
import { StageBar } from '@/renderer/app/StageBar';
import {
  ShellContext,
  type ShellServices,
  settingsSignal,
  transportSignal,
} from '@/renderer/app/shell-context';
import { Ticker } from '@/renderer/app/Ticker';
import { TooltipHost } from '@/renderer/app/TooltipHost';
import { ViewStage } from '@/renderer/app/ViewStage';
import { GraphStage } from '@/renderer/graph/GraphStage';
import { useConfirm } from '@/renderer/hooks/useConfirm';
import { useControl } from '@/renderer/hooks/useControl';
import { useEngineStatus } from '@/renderer/hooks/useEngineStatus';
import { useGraphBoard } from '@/renderer/hooks/useGraphBoard';
import { useLiveFeeds } from '@/renderer/hooks/useLiveFeeds';
import { useLogFeed } from '@/renderer/hooks/useLogFeed';
import { usePruneStatus } from '@/renderer/hooks/usePruneStatus';
import { useScrollReset } from '@/renderer/hooks/useScrollReset';
import { useSettings } from '@/renderer/hooks/useSettings';
import { useStartWatch } from '@/renderer/hooks/useStartWatch';
import { useToasts } from '@/renderer/hooks/useToasts';
import { useTourGate } from '@/renderer/hooks/useTourGate';
import { useTransportControls } from '@/renderer/hooks/useTransportControls';
import { useUpdateStatus } from '@/renderer/hooks/useUpdateStatus';
import { useUpdateToasts } from '@/renderer/hooks/useUpdateToasts';
import { useView, type ViewKey } from '@/renderer/hooks/useView';
import { useViewShortcuts } from '@/renderer/hooks/useViewShortcuts';
import { commas } from '@/renderer/lib/format';
import { staggerCards } from '@/renderer/lib/stagger';
import { Tour } from '@/renderer/tour/Tour';
import { ChainView } from '@/renderer/views/ChainView';
import { OverviewView } from '@/renderer/views/OverviewView';
import { PruneView } from '@/renderer/views/PruneView';
import { QueuesView } from '@/renderer/views/QueuesView';
import { SettingsView } from '@/renderer/views/SettingsView';
import type { StageMode } from '@/types';

/**
 * The dashboard shell. Owns the two status subscriptions, the settings load,
 * the log feed, the toast + confirm layers and view routing — each exactly
 * once. The four projections are published as SIGNALS (see `shell-context.ts`),
 * so the shell subscribes without READING them: a status push or a streamed log
 * line re-renders only the components that read it, never this tree. The engine
 * state is projected onto `.console[data-state]`, which drives the brand ring,
 * transport sheen, and ticker beacon in CSS. Every side-effect machine lives in
 * its own hook.
 */
export function App(): JSX.Element {
  // The shell's four single subscription points. They publish to signals and
  // return nothing — nothing here re-renders when a projection moves.
  useEngineStatus();
  // The prune projection feeds the shell too (unified status): while a prune
  // holds the tab the transport controls IT, not the parked growth engine.
  usePruneStatus();
  useSettings();
  useLogFeed();
  useLiveFeeds();

  const toasts = useToasts();
  const view = useView('overview');
  const { goTo } = view;
  // A view always OPENS at the top — no preserved scroll between tab switches.
  useScrollReset(view.current);
  const confirmCtl = useConfirm();
  const updateStatus = useUpdateStatus();
  const control = useControl(toasts.push);
  const { pending, run } = control;
  // Bumped when Start is pressed without a seed; SettingsView relays it to the
  // seed card, which focuses + flags the field.
  const [seedPrompt, setSeedPrompt] = useState(0);

  // The stage bar (top of the main region) swaps the stage body between the
  // embedded Instagram tab and the graph canvas. 'stage:set' tells main.ts to
  // hide/show the native tab view; the GraphStage itself stays mounted either
  // way, so its camera and layout slots survive round-trips.
  const [stage, setStage] = useState<StageMode>('tab');
  const graphBoard = useGraphBoard(stage === 'graph');
  // The prune page is a card host like a view, so opening it replays the same
  // entrance cascade the console views get.
  const pruneStage = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (stage === 'prune') staggerCards(pruneStage.current);
  }, [stage]);
  // The native tab (and its veil) float above anything this page draws, so an
  // open confirm asks main to cover them — otherwise the whole-window scrim
  // and its dialog render UNDER the Instagram page. The tab keeps running.
  const modalOpen = confirmCtl.state.open;
  useEffect(() => {
    void window.epo.setStage(stage, modalOpen);
  }, [stage, modalOpen]);

  // Land ready to go: Overview + the Instagram tab (where login happens).
  const landAfterTour = useCallback(() => {
    goTo('overview');
    setStage('tab');
  }, [goTo]);
  const tour = useTourGate(landAfterTour);

  useViewShortcuts(goTo, !tour.open);
  useUpdateToasts(updateStatus, tour.open, toasts.push);
  const armStartWatch = useStartWatch(toasts.push);

  const onStart = useCallback(() => {
    // Read at press time, not at render time — the shell does not subscribe to
    // settings just to know whether a seed exists.
    if (!settingsSignal.peek()?.seed?.trim()) {
      setSeedPrompt((n) => n + 1);
      goTo('settings');
      return;
    }
    armStartWatch();
    void run('start', 'Start', () => window.epo.startEngine());
    goTo('overview');
  }, [run, goTo, armStartWatch]);

  const backToOverview = useCallback(() => goTo('overview'), [goTo]);
  const { onPauseResume, onCancel, onLogin } = useTransportControls(
    control,
    confirmCtl.confirm,
    backToOverview,
  );

  // Both are stable useCallbacks, so the services object is built once — a
  // changing context value would re-render every consumer on every render.
  const services = useMemo<ShellServices>(
    () => ({ confirm: confirmCtl.confirm, toast: toasts.push }),
    [confirmCtl.confirm, toasts.push],
  );

  const views: Record<ViewKey, JSX.Element> = {
    overview: <OverviewView pending={pending} onLogin={onLogin} />,
    chain: <ChainView />,
    queues: <QueuesView />,
    settings: (
      <SettingsView
        goTo={goTo}
        seedPrompt={seedPrompt}
        onReplayTour={tour.openTour}
        updateStatus={updateStatus}
      />
    ),
  };

  return (
    <ShellContext.Provider value={services}>
      <div class="shell">
        {/* data-state carries the UNIFIED posture: a prune scan/run reads as
            running (ring breathes, beacon lives), a paused prune as paused —
            the transport trio then controls whichever driver holds the tab.
            `transportSignal` caches its object while the posture is unchanged,
            so the ticking counts underneath never re-render the shell. */}
        <div class="console" data-state={transportSignal.value.state}>
          <Header
            pending={pending}
            onStart={onStart}
            onPauseResume={onPauseResume}
            onCancel={onCancel}
          />
          <Nav current={view.current} onGo={goTo} />
          <ViewStage controller={view} views={views} />
          <Ticker />
          <TooltipHost />

          {/* Permanently mounted (even empty) so the aria-live region exists
              BEFORE the first toast arrives — a region that mounts together with
              its first message is typically not announced by screen readers. */}
          <div class="toasts" role="status" aria-live="polite">
            {toasts.toasts.map((t) => (
              <div key={t.id} class="toast" data-kind={t.kind}>
                <span class="toast__msg">{t.message}</span>
                <button
                  class="toast__close"
                  aria-label="Dismiss"
                  onClick={() => toasts.dismiss(t.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
        <div class="stagepane">
          <StageBar
            stage={stage}
            onSelect={setStage}
            aux={
              stage === 'graph' && graphBoard.snapshot !== null
                ? `${commas(graphBoard.snapshot.pks.length)} nodes`
                : undefined
            }
          />
          <div class="stagepane-body" data-tour="stagebody">
            <GraphStage board={graphBoard} active={stage === 'graph'} />
            {/* Prune lives on the stage (kept mounted so scan results survive
                tab round-trips) and renders its own wide page (.prune-page)
                with the shared console rhythm. */}
            <div class={stage === 'prune' ? 'stage-view active' : 'stage-view'} ref={pruneStage}>
              <PruneView />
            </div>
          </div>
        </div>
        {/* Shell-level (like the tour) so the fixed scrim covers the WHOLE
            window — inside .console its container-type would trap it in the
            console column, leaving stage-hosted (Prune) confirms with a fully
            clickable page behind the open dialog. */}
        <ConfirmHost {...confirmCtl.state} onClose={confirmCtl.close} />
        <Tour open={tour.open} onClose={tour.closeTour} goTo={goTo} setStage={setStage} />
      </div>
    </ShellContext.Provider>
  );
}
