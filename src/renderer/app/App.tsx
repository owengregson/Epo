/** @jsx h */
import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Settings, StageMode } from '@/types';
import { GraphStage } from '../graph/GraphStage';
import { useConfirm } from '../hooks/useConfirm';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useGraphBoard } from '../hooks/useGraphBoard';
import { useLogFeed } from '../hooks/useLogFeed';
import { useScrollReset } from '../hooks/useScrollReset';
import { useToasts } from '../hooks/useToasts';
import { useView, type ViewKey } from '../hooks/useView';
import { commas } from '../lib/format';
import { CARD_STAGGER } from '../lib/motion';
import { Tour } from '../tour/Tour';
import { ChainView } from '../views/ChainView';
import { OverviewView } from '../views/OverviewView';
import { PruneView } from '../views/PruneView';
import { QueuesView } from '../views/QueuesView';
import { SettingsView } from '../views/SettingsView';
import { ConfirmHost } from './ConfirmHost';
import { Header } from './Header';
import { Nav } from './Nav';
import { StageBar } from './StageBar';
import { Ticker } from './Ticker';
import { TooltipHost } from './TooltipHost';
import { ViewStage } from './ViewStage';

/**
 * The dashboard shell. Owns the single engine-status subscription, the settings
 * load, the toast + confirm layers, view routing, and the async control handlers
 * (each shows pending + surfaces typed failures as a toast). The engine state is
 * projected onto `.console[data-state]`, which drives the brand ring, transport
 * sheen, and ticker beacon in CSS.
 */
export function App(): h.JSX.Element {
  const status = useEngineStatus();
  const toasts = useToasts();
  const view = useView('overview');
  const { goTo } = view;
  // A view always OPENS at the top — no preserved scroll between tab switches.
  useScrollReset(view.current);
  const { lines, latest } = useLogFeed();
  const confirmCtl = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Bumped when Start is pressed without a seed; SettingsView relays it to the
  // seed card, which focuses + flags the field.
  const [seedPrompt, setSeedPrompt] = useState(0);

  // The stage bar (top of the main region) swaps the stage body between the
  // embedded Instagram tab and the graph canvas. 'stage:set' tells main.ts to
  // hide/show the native tab view; the GraphStage itself stays mounted either
  // way, so its camera and layout slots survive round-trips.
  const [stage, setStage] = useState<StageMode>('tab');
  const graphBoard = useGraphBoard(stage === 'graph');
  useEffect(() => {
    void window.epo.setStage(stage);
  }, [stage]);

  // The intro tour. Auto-opens once per install (persisted `tourCompletedAt`);
  // replayable from Settings → Data & session. Any way out — Finish, Skip, ×,
  // Esc — persists completion, so it never nags twice.
  const [tourOpen, setTourOpen] = useState(false);
  const tourAutoChecked = useRef(false);
  useEffect(() => {
    if (settings === null || tourAutoChecked.current) return;
    tourAutoChecked.current = true;
    if (settings.tourCompletedAt !== null) return;
    // Let the console's entrance animations land before dimming it.
    const t = window.setTimeout(() => setTourOpen(true), 900);
    return () => window.clearTimeout(t);
  }, [settings]);
  // The tour runs over a QUIET app: while it is open the foundation holds all
  // self-starting work and pauses a running engine ('tour:hold'). On FIRST
  // launch main engages the hold itself (before this renderer even loads);
  // a replay engages it here. Every close path releases it, returning the app
  // to its pre-tour state (deferred startup work runs, a paused engine resumes).
  const openTour = useCallback(() => {
    void window.epo.setTourHold(true);
    setTourOpen(true);
  }, []);
  const closeTour = useCallback(() => {
    setTourOpen(false);
    // Land ready to go: Overview + the Instagram tab (where login happens).
    goTo('overview');
    setStage('tab');
    void window.epo.setTourHold(false);
    window.epo
      .updateSettings({ tourCompletedAt: Date.now() })
      .then(setSettings)
      .catch(() => {
        /* foundation logs; worst case the tour offers itself again next launch */
      });
  }, [goTo]);

  // ⌘/Ctrl+1–4 jump between the console views (hints live on the nav tips).
  useEffect(() => {
    const KEYS: ViewKey[] = ['overview', 'chain', 'queues', 'settings'];
    const onKey = (e: KeyboardEvent): void => {
      if (tourOpen) return; // the tour owns the keyboard while open
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number.parseInt(e.key, 10);
      const key = n >= 1 && n <= KEYS.length ? KEYS[n - 1] : undefined;
      if (key !== undefined) {
        e.preventDefault();
        goTo(key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, tourOpen]);

  // Canonical settings, loaded once (rate meters + dry-run indicator read it; the
  // Settings view edits a draft and reports saves back through onSaved).
  useEffect(() => {
    let alive = true;
    window.epo
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        /* the Settings view shows its own loading state */
      });
    return () => {
      alive = false;
    };
  }, []);

  const runControl = useCallback(
    async (name: string, label: string, fn: () => Promise<unknown>) => {
      setPending(name);
      try {
        const res = await fn();
        // A control REFUSAL is not an IPC rejection — it comes back as a normal
        // status carrying `refusal` (e.g. a prune holds the tab). Without this
        // the button just spun and reverted with zero feedback.
        const refusal =
          typeof res === 'object' && res !== null && 'refusal' in res
            ? (res as { refusal?: string }).refusal
            : undefined;
        if (refusal === 'prune-running') {
          toasts.push('info', `${label} refused — a prune holds the tab; it resumes growth when done.`);
        } else if (refusal !== undefined) {
          toasts.push('error', `${label} refused: ${refusal}`);
        }
      } catch (e) {
        toasts.push('error', `${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setPending(null);
      }
    },
    [toasts],
  );

  const onStart = useCallback(() => {
    if (!settings?.seed?.trim()) {
      setSeedPrompt((n) => n + 1);
      goTo('settings');
      return;
    }
    void runControl('start', 'Start', () => window.epo.startEngine());
    goTo('overview');
  }, [runControl, goTo, settings]);

  const onPauseResume = useCallback(() => {
    const paused = status?.state === 'paused';
    void runControl('pauseResume', paused ? 'Resume' : 'Pause', () =>
      paused ? window.epo.resumeEngine() : window.epo.pauseEngine(),
    );
  }, [runControl, status?.state]);

  const onCancel = useCallback(async () => {
    const ok = await confirmCtl.confirm({
      title: 'Cancel the session?',
      body: 'This ends the current session and resets today’s progress.',
      confirm: 'Cancel & reset',
      dismiss: 'Keep running',
      danger: true,
    });
    if (!ok) return;
    await runControl('stop', 'Cancel', () => window.epo.stopEngine());
    goTo('overview');
  }, [confirmCtl, runControl, goTo]);

  const onLogin = useCallback(
    () => void runControl('login', 'Log in', () => window.epo.login()),
    [runControl],
  );

  const loggedOut = status !== null && !status.loggedIn;

  const views: Record<ViewKey, h.JSX.Element> = {
    overview: (
      <OverviewView
        status={status}
        settings={settings}
        logLines={lines}
        loggedOut={loggedOut}
        pending={pending}
        onLogin={onLogin}
      />
    ),
    chain: <ChainView status={status} />,
    queues: <QueuesView status={status} />,
    settings: (
      <SettingsView
        settings={settings}
        onSaved={setSettings}
        confirm={confirmCtl.confirm}
        goTo={goTo}
        seedPrompt={seedPrompt}
        onReplayTour={openTour}
      />
    ),
  };

  // Publish the card-entrance stagger table (lib/motion.ts CARD_STAGGER) as CSS
  // custom properties so primitives.css and VIEW_ENTER_HOLD_MS share one source.
  const staggerVars =
    `--card-in-dur:${CARD_STAGGER.DUR_MS}ms;` +
    `--card-stagger-step:${CARD_STAGGER.STEP_MS}ms;` +
    `--card-stagger-base:${CARD_STAGGER.BASE_MS}ms;` +
    `--card-stagger-cap:${CARD_STAGGER.CAP}`;

  return (
    // The stagger table rides the shell root so BOTH card hosts inherit it:
    // the console column and the stage-hosted prune column.
    <div class="shell" style={staggerVars}>
      <div class="console" data-state={status?.state ?? 'idle'}>
      <Header
        state={status?.state}
        pending={pending}
        onStart={onStart}
        onPauseResume={onPauseResume}
        onCancel={onCancel}
      />
      <Nav current={view.current} onGo={goTo} />
      <ViewStage controller={view} views={views} />
      <Ticker line={latest} />
      <ConfirmHost {...confirmCtl.state} onClose={confirmCtl.close} />
      <TooltipHost />

      {toasts.toasts.length > 0 ? (
        <div class="toasts" role="status" aria-live="polite">
          {toasts.toasts.map((t) => (
            <div key={t.id} class="toast" data-kind={t.kind}>
              <span class="toast__msg">{t.message}</span>
              <button class="toast__close" aria-label="Dismiss" onClick={() => toasts.dismiss(t.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
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
              tab round-trips) and renders its own wide page (.prune-page,
              graph.css) with the shared console rhythm (layout.css). */}
          <div class={stage === 'prune' ? 'stage-view active' : 'stage-view'}>
            <PruneView
              status={status}
              settings={settings}
              onSaved={setSettings}
              confirm={confirmCtl.confirm}
              toast={toasts.push}
            />
          </div>
        </div>
      </div>
      <Tour open={tourOpen} onClose={closeTour} goTo={goTo} setStage={setStage} />
    </div>
  );
}
