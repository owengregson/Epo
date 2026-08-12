/** @jsx h */
import { h, Fragment } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { LogEntry, PeanutStatus } from '@/types';

const MAX_LOG_LINES = 500;

function ts(at: number): string {
  const d = new Date(at);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function App() {
  const [target, setTarget] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<PeanutStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to the streaming log; unsubscribe on unmount (no listener leaks).
  useEffect(() => {
    const onLog = (entry: LogEntry): void => {
      setLogs((prev) => {
        const next = prev.concat(entry);
        return next.length > MAX_LOG_LINES
          ? next.slice(next.length - MAX_LOG_LINES)
          : next;
      });
    };
    window.peanut.on('log', onLog);
    return () => {
      window.peanut.off('log', onLog);
    };
  }, []);

  // Subscribe to pushed engine status (§5 — pushed on every transition, not polled).
  useEffect(() => {
    const onStatus = (next: PeanutStatus): void => setStatus(next);
    window.peanut.on('status', onStatus);
    return () => {
      window.peanut.off('status', onStatus);
    };
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await window.peanut.status());
    } catch {
      // status is best-effort; failures already surface via the log stream
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const run = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
        void refreshStatus();
      }
    },
    [refreshStatus],
  );

  const onLogin = () => run(async () => void (await window.peanut.login()));
  const onStart = () => run(async () => void (await window.peanut.startEngine()));
  const onPause = () => run(async () => void (await window.peanut.pauseEngine()));
  const onStop = () => run(async () => void (await window.peanut.stopEngine()));
  const onRead = () =>
    run(async () => {
      const t = target.trim();
      if (!t) return;
      await window.peanut.readFollowers(t);
    });
  const onFollow = () =>
    run(async () => {
      const u = username.trim();
      if (!u) return;
      await window.peanut.followOne(u);
    });
  const onUnfollow = () =>
    run(async () => {
      const u = username.trim();
      if (!u) return;
      await window.peanut.unfollowOne(u);
    });

  return (
    <div class="shell">
      <header class="shell__header">
        <div class="brand">
          <span class="brand__mark" />
          <span class="brand__name">Peanut</span>
        </div>
        <div class="status" data-online={status?.loggedIn ? 'true' : 'false'}>
          <span class="status__dot" />
          <span class="status__label">
            {status?.loggedIn ? 'Session active' : 'Signed out'}
          </span>
        </div>
      </header>

      <section class="panel">
        <div class="metrics">
          <div class="metric">
            <span class="metric__value">{status?.actionsToday ?? '—'}</span>
            <span class="metric__label">Actions today</span>
          </div>
          <div class="metric">
            <span class="metric__value">{status?.remainingToday ?? '—'}</span>
            <span class="metric__label">Remaining</span>
          </div>
          <div class="metric">
            <span class="metric__value">
              {status?.requestBudgetRemaining ?? '—'}
            </span>
            <span class="metric__label">Req budget</span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="actions">
          <button class="btn btn--primary" disabled={busy} onClick={onStart}>
            Start engine
          </button>
          <button
            class="btn"
            disabled={busy || status?.state !== 'running'}
            onClick={onPause}
          >
            Pause
          </button>
          <button
            class="btn"
            disabled={busy || (status?.state !== 'running' && status?.state !== 'paused')}
            onClick={onStop}
          >
            Stop
          </button>
        </div>
        <div class="engine-status">
          <span class="engine-status__state" data-state={status?.state ?? 'idle'}>
            {status?.state ?? 'idle'}
          </span>
          <span class="engine-status__line">
            target {status?.currentTargetUsername ?? status?.currentTargetPk ?? '—'} ·{' '}
            {status?.actionsToday ?? 0}/{(status?.actionsToday ?? 0) + (status?.remainingToday ?? 0)} today ·{' '}
            {status?.remainingToday ?? 0} left · q{status?.queued ?? 0} p
            {status?.pendingFollowback ?? 0} h{status?.followedBackHeld ?? 0} u
            {status?.unfollowDue ?? 0}
          </span>
        </div>
      </section>

      <section class="panel">
        <label class="field">
          <span class="field__label">Target account</span>
          <input
            class="field__input"
            type="text"
            placeholder="username to read followers from"
            value={target}
            onInput={(e) =>
              setTarget((e.target as HTMLInputElement).value)
            }
          />
        </label>
        <div class="actions">
          <button class="btn btn--primary" disabled={busy} onClick={onLogin}>
            Login / Open Instagram
          </button>
          <button
            class="btn"
            disabled={busy || !target.trim()}
            onClick={onRead}
          >
            Read followers
          </button>
        </div>
      </section>

      <section class="panel">
        <label class="field">
          <span class="field__label">Action target</span>
          <input
            class="field__input"
            type="text"
            placeholder="username to follow / unfollow"
            value={username}
            onInput={(e) =>
              setUsername((e.target as HTMLInputElement).value)
            }
          />
        </label>
        <div class="actions">
          <button
            class="btn"
            disabled={busy || !username.trim()}
            onClick={onFollow}
          >
            Follow one
          </button>
          <button
            class="btn"
            disabled={busy || !username.trim()}
            onClick={onUnfollow}
          >
            Unfollow one
          </button>
        </div>
      </section>

      <section class="panel panel--log">
        <div class="log__header">
          <span class="log__title">Activity</span>
          <button class="btn btn--ghost" onClick={() => setLogs([])}>
            Clear
          </button>
        </div>
        <div class="log">
          {logs.length === 0 ? (
            <div class="log__empty">No activity yet.</div>
          ) : (
            logs.map((entry, i) => (
              <div
                key={i}
                class="log__line"
                data-level={entry.level}
              >
                <span class="log__time">{ts(entry.at)}</span>
                <span class="log__level">{entry.level}</span>
                <span class="log__msg">{entry.message}</span>
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </section>
    </div>
  );
}
