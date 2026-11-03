import { type JSX } from 'preact';
import { useState } from 'preact/hooks';
import { Header } from '@/renderer/app/Header';
import { Nav } from '@/renderer/app/Nav';
import {
  adoptSettings,
  logSignal,
  pruneSignal,
  ShellContext,
  type ShellServices,
  statusSignal,
  transportSignal,
} from '@/renderer/app/shell-context';
import { Ticker } from '@/renderer/app/Ticker';
import { DIRECTION_SCENARIOS } from '@/renderer/gallery/direction/scenarios';
import { SCENARIOS as BASE_SCENARIOS, GALLERY_LOG, GALLERY_SETTINGS, type Scenario } from '@/renderer/gallery/fixtures';
import { LIVE_SCENARIOS } from '@/renderer/gallery/fixtures-live';
import { SURFACE_SCENARIOS } from '@/renderer/gallery/fixtures-surface';
import { installGalleryBridge } from '@/renderer/gallery/gallery-bridge';
import type { ViewKey } from '@/renderer/hooks/useView';
import { staggerCards } from '@/renderer/lib/stagger';
import { ChainView } from '@/renderer/views/ChainView';
import { OverviewView } from '@/renderer/views/OverviewView';
import { PruneView } from '@/renderer/views/PruneView';
import { QueuesView } from '@/renderer/views/QueuesView';
import { SettingsView } from '@/renderer/views/SettingsView';

/** The view picker's rail, in nav order, plus the stage-hosted prune page. */
const SURFACES = [
  { key: 'overview', label: 'Overview' },
  { key: 'chain', label: 'Targets' },
  { key: 'queues', label: 'Queues' },
  { key: 'settings', label: 'Settings' },
  { key: 'prune', label: 'Prune' },
] as const;

type SurfaceKey = (typeof SURFACES)[number]['key'];

/** Every story: the console's, then the live column's, then the compatibility surfaces'. */
const SCENARIOS: Scenario[] = [...BASE_SCENARIOS, ...LIVE_SCENARIOS, ...SURFACE_SCENARIOS, ...DIRECTION_SCENARIOS];

/** Publish one scenario onto the shell's signals — this IS mounting a story. */
function applyScenario(s: Scenario): void {
  statusSignal.value = s.status;
  pruneSignal.value = s.prune;
}

const NOOP_SERVICES: ShellServices = {
  confirm: () => Promise.resolve(true),
  toast: () => {},
};

/**
 * The dev-only component gallery, reached at `?gallery=1` (ADR 1006 — why this
 * and not Storybook).
 *
 * It renders the REAL views inside the REAL `.console` markup, so container
 * queries, the `[data-state]` cascade and the card entrance all behave exactly
 * as they do in the app; a "story" is just a set of projections written to the
 * shell signals. Nothing here is reachable without the query flag, and no
 * fixture is imported by the app itself.
 */
export function Gallery(): JSX.Element {
  const [scenarioKey, setScenarioKey] = useState(SCENARIOS[1]?.key ?? 'idle');
  const [surface, setSurface] = useState<SurfaceKey>('overview');

  const views: Record<ViewKey, JSX.Element> = {
    overview: <OverviewView pending={null} onLogin={() => {}} />,
    chain: <ChainView />,
    queues: <QueuesView />,
    settings: (
      <SettingsView goTo={() => {}} seedPrompt={0} onReplayTour={() => {}} updateStatus={null} />
    ),
  };

  return (
    <ShellContext.Provider value={NOOP_SERVICES}>
      <div class="shell gallery">
        <div class="console" data-state={transportSignal.value.state}>
          <Header pending={null} onStart={() => {}} onPauseResume={() => {}} onCancel={() => {}} />
          <Nav current={surface === 'prune' ? 'overview' : surface} onGo={setSurface} />
          <div class="viewstage">
            <section
              class="view active"
              id={`view-${surface}`}
              ref={(el) => staggerCards(el as HTMLElement | null)}
              key={`${surface}:${scenarioKey}`}
            >
              {surface === 'prune' ? <PruneView /> : views[surface]}
            </section>
          </div>
          <Ticker />
        </div>
        <div class="stagepane">
          <div class="gallery-rail">
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
            <div class="gallery-rail__h">Surface</div>
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
              Dev gallery — every card is the real component reading the real shell signals. Drop
              the <code>?gallery=1</code> flag for the app.
            </p>
          </div>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

/**
 * Seed the signals and stub the bridge before the first paint, so the gallery
 * never reaches a main process (and a card that pulls gets fixture data rather
 * than a rejected promise).
 */
export function primeGallery(): void {
  installGalleryBridge();
  adoptSettings(GALLERY_SETTINGS);
  logSignal.value = GALLERY_LOG.map((entry, seq) => ({ ...entry, seq }));
  applyScenario(SCENARIOS[1] ?? (SCENARIOS[0] as Scenario));
}
