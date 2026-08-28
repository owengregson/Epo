/** @jsx h */
import { h } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { EpoStatus, Settings, StageMode } from '@/types';
import { GraphStage } from '../graph/GraphStage';
import { useConfirm } from '../hooks/useConfirm';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useGraphBoard } from '../hooks/useGraphBoard';
import { useLogFeed } from '../hooks/useLogFeed';
import { useScrollReset } from '../hooks/useScrollReset';
import { useToasts } from '../hooks/useToasts';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
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

  // Self-updater status (pushed from main). One toast per state transition —
  // suppressed while the tour is open (the tour runs over a quiet app; when it
  // closes, the effect re-runs and the toast lands then).
  const updateStatus = useUpdateStatus();
  const updateToastKey = useRef<string | null>(null);
  useEffect(() => {
    if (updateStatus === null || tourOpen) return;
    const key = `${updateStatus.state}:${updateStatus.version ?? ''}`;
    if (updateToastKey.current === key) return;
    if (updateStatus.state === 'ready') {
      updateToastKey.current = key;
      toasts.push(
        'info',
        `Epo v${updateStatus.version} is downloaded — restart from Settings → Updates, or it installs when you quit.`,
      );
    } else if (updateStatus.state === 'available' && updateStatus.mode === 'notify') {
      updateToastKey.current = key;
      toasts.push('info', `Epo v${updateStatus.version} is available — see Settings → Updates.`);
    }
  }, [updateStatus, tourOpen, toasts]);

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

  // One-shot Start watch: pressing Start outside the activity window otherwise
  // yields hours of silence. Armed on a user-initiated Start with the engine's
  // step markers at press time; the next pushed statuses are inspected — the
  // first one carrying a window park gets the toast, and any other sign of the
  // engine at work (a different park, a step marker moving) disarms silently.
  // Time-boxed: a first-thing park registers within seconds of Start, so an
  // expired watch can never toast "Started" long after the button press.
  const startWatch = useRef<{
    lastStep: EpoStatus['lastStep'];
    lastActionAt: number | null;
    armedAt: number;
  } | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const armed = startWatch.current;
    if (armed === null || status === null) return;
    if (Date.now() - armed.armedAt > 90_000) {
      startWatch.current = null; // stale — whatever happens now is not "at Start"
      return;
    }
    if (status.state === 'idle' || status.state === 'halted') {
      startWatch.current = null; // start refused, failed, or already over
      return;
    }
    const reason = status.parkReason ?? null;
    const until = status.parkedUntil ?? null;
    if ((reason === 'active-hours' || reason === 'session') && until != null) {
      startWatch.current = null;
      const d = new Date(until);
      toasts.push(
        'info',
        `Started — first actions at ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}.`,
      );
      return;
    }
    if (reason != null || status.lastStep !== armed.lastStep || status.lastActionAt !== armed.lastActionAt) {
      startWatch.current = null; // the engine went to work — no hold toast owed
    }
  }, [status, toasts]);

  const onStart = useCallback(() => {
    if (!settings?.seed?.trim()) {
      setSeedPrompt((n) => n + 1);
      goTo('settings');
      return;
    }
    startWatch.current = {
      lastStep: statusRef.current?.lastStep ?? null,
      lastActionAt: statusRef.current?.lastActionAt ?? null,
      armedAt: Date.now(),
    };
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
      body: 'Stops the engine between actions. Today’s action count is kept; pacing resumes where it left off.',
      confirm: 'Stop engine',
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
        toast={toasts.push}
        seedPrompt={seedPrompt}
        onReplayTour={openTour}
        updateStatus={updateStatus}
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
