/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": [""]}
 *
 * LiveStatusCard rendered. Covers the three hero postures (countdown, park
 * hold, offline hold) and the halt banner — the branches the pure-copy tests
 * cannot reach.
 */
import { render, screen } from '@testing-library/preact';
import { type JSX } from 'preact';
import { LiveStatusCard } from '@/renderer/cards/overview/LiveStatusCard';
import { DEFAULT_SETTINGS } from '@/settings/settings';
import {
  type FakeBridge,
  idlePruneStatus,
  idleStatus,
  installFakeBridge,
} from '../kit/render-bridge';

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge(DEFAULT_SETTINGS);
});

const card = (status: Parameters<typeof idleStatus>[0]): JSX.Element => (
  <LiveStatusCard
    status={idleStatus(status)}
    prune={idlePruneStatus()}
    settings={DEFAULT_SETTINGS}
  />
);

describe('LiveStatusCard — hero postures', () => {
  const runtime = (over: Partial<NonNullable<ReturnType<typeof idleStatus>['runtime']>> = {}) => ({
    desired: 'running' as const, phase: 'ready' as const, blockedReason: null,
    lastProgressAt: Date.now() - 120_000, progressPhase: 'relationships-reconciled', incidents: [], ...over,
  });

  it('device recovery takes precedence over a stale action countdown', () => {
    render(card({ state: 'idle', nextActionAt: Date.now() + 30_000, runtime: runtime({ phase: 'recovering' }) }));
    screen.getByText('Recovering');
    screen.getByText(/Last progress .*relationships reconciled/);
    expect(screen.queryByText('until next action')).toBeNull();
  });

  it('a persistent device block stays visible even when the engine is idle', () => {
    render(card({ state: 'idle', runtime: runtime({ blockedReason: 'account-changed' }) }));
    screen.getByText('Needs attention');
    expect(screen.getByRole('alert').textContent).toMatch(/signed-in account changed/);
  });

  it('return reconciliation and consecutive failures are visible without implying actions resumed', () => {
    render(card({ state: 'running', runtime: runtime(),
      reentry: { v: 1, phase: 'reconcile', reason: 'absence', absentMs: 7 * 86_400_000,
        lastActiveAt: null, lastReconciledAt: null, reconciliationStartedAt: Date.now(), probationActions: 0, nextProbationActionAt: null, timezoneOffset: 0 },
      health: { version: 1, consecutiveErrors: 2, lastError: 'profile read timed out',
        lastErrorAt: Date.now(), lastProgressAt: null, progressPhase: null },
    }));
    screen.getByText('Refreshing');
    screen.getByText(/7d 0h away/);
    screen.getByText(/2 consecutive step failures.*profile read timed out/);
  });

  it('running with a pending deadline counts down to the next action', () => {
    const now = Date.now();
    render(card({ state: 'running', lastActionAt: now - 60_000, nextActionAt: now + 120_000 }));
    screen.getByText('until next action');
    // mm:ss, not a dash — the countdown is live.
    screen.getByText(/^\d+:\d{2}$/);
  });

  it('running-but-parked renders the hold headline and resume time, not dashes', () => {
    const now = Date.now();
    render(card({ state: 'running', parkReason: 'active-hours', parkedUntil: now + 3 * 3600_000 }));
    screen.getByText('Resting');
    screen.getByText(/outside active hours · resumes/);
    expect(screen.queryByText('until next action')).toBeNull();
  });

  it('offline while running wins over a park — no fabricated numbers', () => {
    const now = Date.now();
    render(
      card({
        state: 'running',
        online: false,
        parkReason: 'active-hours',
        parkedUntil: now + 3600_000,
      }),
    );
    screen.getByText('Offline');
    screen.getByText('waiting for connection');
    screen.getByText('Reconnecting…');
    expect(screen.queryByText('Resting')).toBeNull();
  });

  it('halted renders the reason as an alert', () => {
    render(card({ state: 'halted', haltReason: 'chain-exhausted' }));
    expect(screen.getByRole('alert').textContent).toMatch(/target chain is exhausted/);
  });

  it('an unknown halt reason still surfaces verbatim rather than vanishing', () => {
    render(card({ state: 'halted', haltReason: 'something-new' }));
    expect(screen.getByRole('alert').textContent).toBe('Halted — something-new.');
  });

  it('a recovery hold prefers the rung-aware caption over the generic one', () => {
    const now = Date.now();
    render(
      card({
        state: 'running',
        parkReason: 'recovery',
        parkedUntil: now + 1800_000,
        recovery: { phase: 'holding', attempt: 2, maxAttempts: 3, resumeAt: now + 1800_000 },
      }),
    );
    screen.getByText(/attempt 2 of 3/);
  });

  it('reads the queues through the bridge (the "next" line is graph-derived)', () => {
    render(card({ state: 'running' }));
    expect(bridge.calls.filter((c) => c[0] === 'queueList').length).toBeGreaterThan(0);
  });
});
