import { type JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ConfirmHost } from '@/renderer/app/ConfirmHost';
import { chainListSignal, growthSeriesSignal, queueLanesSignal } from '@/renderer/app/live-signals';
import { StageBar } from '@/renderer/app/StageBar';
import {
  modalSignal,
  peopleTargetSignal,
  pruneSignal,
  ShellContext,
  type ShellControls,
  ShellControlsContext,
  settingsTargetSignal,
  stageSignal,
  statusSignal,
} from '@/renderer/app/shell-context';
import { DIRECTION_SCENARIOS } from '@/renderer/gallery/direction/scenarios';
import { SCENARIOS as BASE_SCENARIOS, GALLERY_CHAIN, type GalleryGraphState, galleryGraph, type Scenario } from '@/renderer/gallery/fixtures';
import { LIVE_SCENARIOS, resetLiveGallery } from '@/renderer/gallery/fixtures-live';
import { SETTINGS_SCENARIOS } from '@/renderer/gallery/fixtures-settings';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { GALLERY_SURFACES, GalleryStage, type GallerySurface } from '@/renderer/gallery/GalleryStage';
import { answerInGallery, GALLERY_LANES, installGalleryBridge } from '@/renderer/gallery/gallery-bridge';
import { useConfirm } from '@/renderer/hooks/useConfirm';
import type { ToastControls } from '@/renderer/hooks/useToasts';
import { Sidebar } from '@/renderer/sidebar/Sidebar';
import { Tour } from '@/renderer/tour/Tour';
import type { StageMode } from '@/shared/stage-mode';

/** Every story: the console's, the live column's, the compatibility surfaces', Settings', then the direction boards. */
const SCENARIOS: Scenario[] = [
  ...BASE_SCENARIOS, ...LIVE_SCENARIOS, ...SURFACE_SCENARIOS, ...SETTINGS_SCENARIOS, ...DIRECTION_SCENARIOS,
];

/** Publish one scenario onto the shell's signals — this IS mounting a story. */
function applyScenario(s: Scenario): void {
  statusSignal.value = s.status;
  const allocation = s.status.plan?.kinds.unfollow;
  pruneSignal.value = allocation === undefined ? s.prune
    : { ...s.prune, dailyLimit: allocation.planned, dailyDone: allocation.done };
  peopleTargetSignal.value = null;
  settingsTargetSignal.value = null;
  resetLiveGallery();
  s.apply?.();
}

const noop = (): void => undefined;

/** The live column's toast stack, quiet in the gallery. */
const NO_TOASTS: ToastControls = { toasts: [], push: noop, dismiss: noop };

/**
 * The dev-only component gallery, reached at `?gallery=1` (ADR 1006 — why this
 * and not Storybook).
 *
 * It renders the REAL live column and the REAL stage pages, so container
 * queries, the `[data-state]` cascade and the entrance all behave exactly as in
 * the app; a "story" is just a set of projections written to the shell signals.
 * Nothing here is reachable without the query flag, and no fixture is imported
 * by the app itself.
 */
export function Gallery(): JSX.Element {
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[1]?.key ?? 'idle');
  const [surface, setSurface] = useState<GallerySurface>('people');
  const [graphState, setGraphState] = useState<GalleryGraphState>('populated');
  const [tourOpen, setTourOpen] = useState(false);
  const beforeTour = useRef<GallerySurface>('people');
  const confirmation = useConfirm();
  const [controlsHidden, setControlsHidden] = useState(false);

  const selectSurface = useCallback((next: GallerySurface): void => {
    setSurface(next);
    if (next !== 'diagnostics') stageSignal.value = next === 'live' ? 'tab' : next;
  }, []);
  const showStage = useCallback((mode: StageMode): void => selectSurface(mode === 'tab' ? 'live' : mode), [selectSurface]);
  const openTour = (): void => { beforeTour.current = surface; setTourOpen(true); };
  const closeTour = (): void => { setTourOpen(false); selectSurface(beforeTour.current); };
  const controls: ShellControls = {
    showStage,
    openPerson: (person) => { peopleTargetSignal.value = person; selectSurface('people'); },
    openSettings: (target) => { settingsTargetSignal.value = target ?? null; selectSurface('settings'); },
    start: noop, pauseResume: noop, stop: () => Promise.resolve(),
    signIn: () => selectSurface('live'), replayTour: openTour,
  };
  const chooseGraph = (next: GalleryGraphState): void => {
    answerInGallery('graphSnapshot', galleryGraph(next));
    setGraphState(next);
    selectSurface('graph');
  };
  useEffect(() => {
    modalSignal.value = confirmation.state.open || tourOpen;
    return () => { modalSignal.value = false; };
  }, [confirmation.state.open, tourOpen]);

  return (
    <ShellContext.Provider value={{ confirm: confirmation.confirm, toast: noop }}>
      <ShellControlsContext.Provider value={controls}>
      <div class="shell gallery">
        <Sidebar key={scenarioKey} toasts={NO_TOASTS} update={null} />
        <div class="stagepane">
          <StageBar stage={stageSignal.value} onSelect={showStage} />
          <GalleryStage key={scenarioKey} surface={surface} graphKey={graphState} />
        </div>
        {controlsHidden ? <button type="button" class="tbtn gallery-show" onClick={() => setControlsHidden(false)}>Show gallery controls</button> : null}
        <aside class="gallery-rail" hidden={controlsHidden}>
          <button type="button" class="tbtn" onClick={() => setControlsHidden(true)}>Hide gallery controls</button>
          <div class="gallery-rail__h">Scenario</div>
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              type="button"
              class={s.key === scenarioKey ? 'chip active' : 'chip'}
              onClick={() => {
                applyScenario(s);
                answerInGallery('graphSnapshot', galleryGraph('populated'));
                setGraphState('populated');
                setScenarioKey(s.key);
              }}
            >
              {s.label}
            </button>
          ))}
          <div class="gallery-rail__h">Page</div>
          {GALLERY_SURFACES.map((s) => (
            <button
              key={s.key}
              type="button"
              class={s.key === surface ? 'chip active' : 'chip'}
              onClick={() => selectSurface(s.key)}
            >
              {s.label}
            </button>
          ))}
          <div class="gallery-rail__h">Review overlays and graph states</div>
          {(['empty', 'populated', 'unavailable'] as const).map((state) => <button key={state} type="button" class="tbtn" onClick={() => chooseGraph(state)}>Graph {state}</button>)}
          <button type="button" class="tbtn" onClick={openTour}>Start intro tour</button>
          <button type="button" class="tbtn" onClick={() => void confirmation.confirm({
            title: 'Enable gradual cleanup?', body: 'Epo will unfollow a few eligible accounts each day. Protected accounts stay followed.',
            confirm: 'Enable cleanup', dismiss: 'Keep it off',
          })}>Open confirmation</button>
          <button type="button" class="tbtn" onClick={() => void confirmation.confirm({
            title: 'Stop the prune run?', body: 'The accounts already unfollowed stay unfollowed.',
            confirm: 'Stop run', dismiss: 'Keep running', danger: true,
          })}>Open destructive confirmation</button>
          <p class="gallery-rail__note">
            Dev gallery — every card is the real component reading the real shell signals. Drop the{' '}
            <code>?gallery=1</code> flag for the app.
          </p>
        </aside>
      </div>
      <ConfirmHost {...confirmation.state} onClose={confirmation.close} />
      <Tour open={tourOpen} onClose={closeTour} setStage={showStage} />
      </ShellControlsContext.Provider>
    </ShellContext.Provider>
  );
}

/**
 * Seed the signals and stub the bridge before the first paint, so the gallery
 * never reaches a main process (a page that pulls gets fixture data rather than
 * a rejected promise) and the stage pages find the data the shell would have
 * fetched before the reveal.
 */
export function primeGallery(): void {
  installGalleryBridge();
  answerInGallery('graphSnapshot', galleryGraph('populated'));
  peopleTargetSignal.value = null;
  settingsTargetSignal.value = null;
  modalSignal.value = false;
  chainListSignal.value = GALLERY_CHAIN;
  growthSeriesSignal.value = { points: [], baselineAt: null };
  queueLanesSignal.value = GALLERY_LANES;
  stageSignal.value = 'people';
  applyScenario(SCENARIOS[1] ?? (SCENARIOS[0] as Scenario));
}
