import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { chainListSignal, growthSeriesSignal, queueLanesSignal } from '@/renderer/app/live-signals';
import {
  adoptSettings,
  logSignal,
  pruneSignal,
  ShellContext,
  type ShellControls,
  ShellControlsContext,
  type ShellServices,
  statusSignal,
  transportSignal,
} from '@/renderer/app/shell-context';
import { DIRECTION_SCENARIOS } from '@/renderer/gallery/direction/scenarios';
import {
  SCENARIOS as BASE_SCENARIOS,
  GALLERY_CHAIN,
  GALLERY_LOG,
  GALLERY_SETTINGS,
  type Scenario,
} from '@/renderer/gallery/fixtures';
import { LIVE_SCENARIOS } from '@/renderer/gallery/fixtures-live';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { GALLERY_LANES, installGalleryBridge } from '@/renderer/gallery/gallery-bridge';
import { staggerCards } from '@/renderer/lib/stagger';
import { PeoplePage } from '@/renderer/pages/PeoplePage';
import { SettingsStage } from '@/renderer/settings/SettingsStage';
import { OverviewView } from '@/renderer/views/OverviewView';
import { PruneView } from '@/renderer/views/PruneView';

/** The stage pages the picker can show beside the console column. */
const SURFACES = [
  { key: 'people', label: 'People' },
  { key: 'prune', label: 'Prune' },
  { key: 'settings', label: 'Settings' },
] as const;

type SurfaceKey = (typeof SURFACES)[number]['key'];

/** Every story: the console's, the live column's, the compatibility surfaces', then the direction boards. */
const SCENARIOS: Scenario[] = [...BASE_SCENARIOS, ...LIVE_SCENARIOS, ...SURFACE_SCENARIOS, ...DIRECTION_SCENARIOS];

/** Publish one scenario onto the shell's signals — this IS mounting a story. */
function applyScenario(s: Scenario): void {
  statusSignal.value = s.status;
  pruneSignal.value = s.prune;
}

const noop = (): void => undefined;

const NOOP_SERVICES: ShellServices = { confirm: () => Promise.resolve(true), toast: noop };

const NOOP_CONTROLS: ShellControls = {
  showStage: noop,
  openSettings: noop,
  start: noop,
  pauseResume: noop,
  stop: () => Promise.resolve(),
  signIn: noop,
  replayTour: noop,
};

function Surface({ surface }: { surface: SurfaceKey }): JSX.Element {
  switch (surface) {
    case 'people':
      return <PeoplePage />;
    case 'prune':
      return <PruneView />;
    case 'settings':
      return <SettingsStage goTo={noop} seedPrompt={0} onReplayTour={noop} updateStatus={null} />;
  }
}

/**
 * The dev-only component gallery, reached at `?gallery=1` (ADR 1006 — why this
 * and not Storybook).
 *
 * It renders the REAL console column and the REAL stage pages, so container
 * queries, the `[data-state]` cascade and the entrance all behave exactly as in
 * the app; a "story" is just a set of projections written to the shell signals.
 * Nothing here is reachable without the query flag, and no fixture is imported
 * by the app itself.
 */
export function Gallery(): JSX.Element {
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[1]?.key ?? 'idle');
  const [surface, setSurface] = useState<SurfaceKey>('people');

  return (
    <ShellContext.Provider value={NOOP_SERVICES}>
      <ShellControlsContext.Provider value={NOOP_CONTROLS}>
      <div class="shell gallery">
        <div class="console" data-state={transportSignal.value.state}>
          <div class="viewstage">
            <section
              class="view active"
              id="view-overview"
              ref={(el) => staggerCards(el as HTMLElement | null)}
              key={scenarioKey}
            >
              <OverviewView pending={null} onLogin={noop} />
            </section>
          </div>
        </div>
        <div class="stagepane">
          <div class="stagepane-body">
            <section class="stage-view active" data-stage={surface} key={`${surface}:${scenarioKey}`}>
              <Surface surface={surface} />
            </section>
          </div>
        </div>
        <aside class="gallery-rail">
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
  adoptSettings(GALLERY_SETTINGS);
  logSignal.value = GALLERY_LOG.map((entry, seq) => ({ ...entry, seq }));
  chainListSignal.value = GALLERY_CHAIN;
  growthSeriesSignal.value = { points: [], baselineAt: null };
  queueLanesSignal.value = GALLERY_LANES;
  applyScenario(SCENARIOS[1] ?? (SCENARIOS[0] as Scenario));
}
