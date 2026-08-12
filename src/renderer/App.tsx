/** @jsx h */
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { Settings } from '@/types';
import { useEngineStatus } from './hooks/useEngineStatus';
import { useToasts } from './hooks/useToasts';
import { ControlBar } from './components/ControlBar';
import { ChainPanel } from './components/ChainPanel';
import { RatePanel } from './components/RatePanel';
import { QueuePanel } from './components/QueuePanel';
import { ActivityLog } from './components/ActivityLog';
import { SettingsPanel } from './components/SettingsPanel';

/**
 * The dashboard shell (spec §6): owns the one engine-status subscription and the
 * toast layer, wires the control handlers (each shows pending + a typed failure
 * toast), and stacks the seven panels. No panel owns more than its own state.
 */
export function App(): h.JSX.Element {
  const status = useEngineStatus();
  const toasts = useToasts();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // Canonical settings — loaded once for the dry-run indicator and the rate meters;
  // the settings panel edits a draft and reports saves back through onSaved.
  useEffect(() => {
    let alive = true;
    window.peanut
      .getSettings()
      .then((s) => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        // best-effort; the settings panel shows its own loading state
      });
    return () => {
      alive = false;
    };
  }, []);

  const runControl = useCallback(
    async (name: string, label: string, fn: () => Promise<unknown>) => {
      setPending(name);
      try {
        await fn();
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        toasts.push('error', `${label} failed: ${reason}`);
      } finally {
        setPending(null);
      }
    },
    [toasts],
  );

  const onStart = useCallback(
    () => void runControl('start', 'Start', () => window.peanut.startEngine()),
    [runControl],
  );
  const onStop = useCallback(
    () => void runControl('stop', 'Stop', () => window.peanut.stopEngine()),
    [runControl],
  );
  const onPauseResume = useCallback(() => {
    const paused = status?.state === 'paused';
    void runControl('pauseResume', paused ? 'Resume' : 'Pause', () =>
      paused ? window.peanut.resumeEngine() : window.peanut.pauseEngine(),
    );
  }, [runControl, status?.state]);
  const onLogin = useCallback(
    () => void runControl('login', 'Log in', () => window.peanut.login()),
    [runControl],
  );

  const loggedOut = status !== null && !status.loggedIn;

  return (
    <div class="app">
      <ControlBar
        status={status}
        pending={pending}
        dryRun={settings?.dryRun ?? false}
        onStart={onStart}
        onPauseResume={onPauseResume}
        onStop={onStop}
      />

      <div class="app__scroll">
        {loggedOut ? (
          <div class="signin">
            <div class="signin__title">Not signed in</div>
            <p class="signin__body">
              Open Instagram in the tab on the right and log in. The engine builds
              itself the moment your session is live.
            </p>
            <button
              class="btn btn--primary"
              disabled={pending === 'login'}
              onClick={onLogin}
            >
              {pending === 'login' ? 'Opening…' : 'Open Instagram'}
            </button>
          </div>
        ) : null}

        <ChainPanel status={status} />
        <RatePanel status={status} settings={settings} />
        <QueuePanel status={status} />
        <ActivityLog />
        <SettingsPanel settings={settings} onSaved={setSettings} toasts={toasts} />
      </div>

      {toasts.toasts.length > 0 ? (
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
      ) : null}
    </div>
  );
}
