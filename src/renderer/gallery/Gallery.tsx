import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { chainListSignal, growthSeriesSignal, queueLanesSignal } from '@/renderer/app/live-signals';
import {
  pruneSignal,
  ShellContext,
  type ShellControls,
  ShellControlsContext,
  type ShellServices,
  stageSignal,
  statusSignal,
} from '@/renderer/app/shell-context';
import { LivePlaceholder } from '@/renderer/boot/LivePlaceholder';
import { DiagnosticsPanel } from '@/renderer/diagnostics/DiagnosticsPanel';
import { DIRECTION_SCENARIOS } from '@/renderer/gallery/direction/scenarios';
import { SCENARIOS as BASE_SCENARIOS, GALLERY_CHAIN, type Scenario } from '@/renderer/gallery/fixtures';
import { LIVE_SCENARIOS, resetLiveGallery } from '@/renderer/gallery/fixtures-live';
import { SETTINGS_SCENARIOS } from '@/renderer/gallery/fixtures-settings';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { GALLERY_LANES, installGalleryBridge } from '@/renderer/gallery/gallery-bridge';
import type { ToastControls } from '@/renderer/hooks/useToasts';
import { PeoplePage } from '@/renderer/pages/PeoplePage';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { Sidebar } from '@/renderer/sidebar/Sidebar';
import { PruneView } from '@/renderer/views/PruneView';

/** The stage pages the picker can show beside the live column. */
const SURFACES = [
  { key: 'people', label: 'People' },
  { key: 'prune', label: 'Prune' },
  { key: 'settings', label: 'Settings' },
  { key: 'live', label: 'Live placeholder' },
  { key: 'diagnostics', label: 'Diagnostics' },
] as const;

type SurfaceKey = (typeof SURFACES)[number]['key'];

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
  resetLiveGallery();
  s.apply?.();
}

const noop = (): void => undefined;

const NOOP_SERVICES: ShellServices = { confirm: () => Promise.resolve(true), toast: noop };

const NOOP_CONTROLS: ShellControls = {
  showStage: noop,
  openPerson: noop,
  openSettings: noop,
  start: noop,
  pauseResume: noop,
  stop: () => Promise.resolve(),
  signIn: noop,
  replayTour: noop,
};

/** The live column's toast stack, quiet in the gallery. */
const NO_TOASTS: ToastControls = { toasts: [], push: noop, dismiss: noop };

function Surface({ surface }: { surface: SurfaceKey }): JSX.Element {
  switch (surface) {
    case 'people':
      return <PeoplePage />;
    case 'prune':
      return <PruneView />;
    case 'settings':
      return <SettingsStage updateStatus={null} />;
    case 'live':
      return <LivePlaceholder />;
    case 'diagnostics':
      return <DiagnosticsPanel />;
  }
}

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
  const [surface, setSurface] = useState<SurfaceKey>('people');
  const [controlsHidden, setControlsHidden] = useState(false);

  return (
    <ShellContext.Provider value={NOOP_SERVICES}>
      <ShellControlsContext.Provider value={NOOP_CONTROLS}>
      <div class="shell gallery">
        <Sidebar key={scenarioKey} toasts={NO_TOASTS} update={null} />
        <div class="stagepane">
          <div class="stagepane-body">
            <section class="stage-view active" data-stage={surface} key={`${surface}:${scenarioKey}`}>
              <Surface surface={surface} />
            </section>
          </div>
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
                setScenarioKey(s.key);
              }}
            >
              {s.label}
            </button>
          ))}
          <div class="gallery-rail__h">Page</div>
          {SURFACES.map((s) => (
            <button
              key={s.key}
              type="button"
              class={s.key === surface ? 'chip active' : 'chip'}
              onClick={() => setSurface(s.key)}
            >
              {s.label}
            </button>
          ))}
          <p class="gallery-rail__note">
            Dev gallery — every card is the real component reading the real shell signals. Drop the{' '}
            <code>?gallery=1</code> flag for the app.
          </p>
        </aside>
      </div>
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
  chainListSignal.value = GALLERY_CHAIN;
  growthSeriesSignal.value = { points: [], baselineAt: null };
  queueLanesSignal.value = GALLERY_LANES;
  stageSignal.value = 'people';
  applyScenario(SCENARIOS[1] ?? (SCENARIOS[0] as Scenario));
}
