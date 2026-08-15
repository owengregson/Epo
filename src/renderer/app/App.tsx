/** @jsx h */
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { CARD_STAGGER } from '../lib/motion';
import { useEngineStatus } from '../hooks/useEngineStatus';
import { useToasts } from '../hooks/useToasts';
import { useScrollReset } from '../hooks/useScrollReset';
import { useView, type ViewKey } from '../hooks/useView';
import { useLogFeed } from '../hooks/useLogFeed';
import { useConfirm } from '../hooks/useConfirm';
import { Header } from './Header';
import { Nav } from './Nav';
import { ViewStage } from './ViewStage';
import { Ticker } from './Ticker';
import { ConfirmHost } from './ConfirmHost';
import { TooltipHost } from './TooltipHost';
import { OverviewView } from '../views/OverviewView';
import { ChainView } from '../views/ChainView';
import { QueuesView } from '../views/QueuesView';
import { PruneView } from '../views/PruneView';
import { SettingsView } from '../views/SettingsView';

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
    prune: (
      <PruneView
        status={status}
        settings={settings}
        onSaved={setSettings}
        confirm={confirmCtl.confirm}
        toast={toasts.push}
      />
    ),
    settings: (
      <SettingsView
        settings={settings}
        onSaved={setSettings}
        confirm={confirmCtl.confirm}
        goTo={goTo}
        seedPrompt={seedPrompt}
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
    <div class="console" data-state={status?.state ?? 'idle'} style={staggerVars}>
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
  );
}
