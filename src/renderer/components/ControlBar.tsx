/** @jsx h */
import { h, Fragment } from 'preact';
import type { PeanutStatus } from '@/types';

export interface ControlBarProps {
  status: PeanutStatus | null;
  /** The control currently in flight (disables the row), or null. */
  pending: string | null;
  dryRun: boolean;
  onStart: () => void;
  onPauseResume: () => void;
  onStop: () => void;
}

const STATE_LABEL: Record<string, string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  halted: 'Halted',
};

/** A short, human reason for a halt, from whatever the status carries. */
function haltReason(status: PeanutStatus): string | null {
  if (status.state !== 'halted') return null;
  if (status.lastSentinel && status.lastSentinel !== 'ok') {
    return `Instagram sentinel: ${status.lastSentinel}`;
  }
  return 'Stopped for safety — check the activity log';
}

/**
 * The sticky control surface (spec §3): a colorized state pill (running pulses,
 * halted is danger, paused is brass) and the Start / Pause·Resume / Stop trio. The
 * primary control carries the one brushed-metal sheen. Every button shows pending.
 */
export function ControlBar({
  status,
  pending,
  dryRun,
  onStart,
  onPauseResume,
  onStop,
}: ControlBarProps): h.JSX.Element {
  const state = status?.state ?? 'idle';
  const busy = pending !== null;
  const running = state === 'running';
  const paused = state === 'paused';
  const canStart = state === 'idle' || state === 'halted';
  const reason = status ? haltReason(status) : null;

  return (
    <div class="controlbar">
      <div class="controlbar__row">
        <span class="pill" data-state={state}>
          <span class="pill__dot" />
          <span class="pill__label">{STATE_LABEL[state] ?? state}</span>
        </span>
        {dryRun ? <span class="tag tag--warn">Dry run</span> : null}

        <div class="controlbar__spacer" />

        {canStart ? (
          <button
            class="btn btn--primary"
            disabled={busy}
            onClick={onStart}
            aria-busy={pending === 'start'}
          >
            {pending === 'start' ? 'Starting…' : 'Start'}
          </button>
        ) : (
          <button
            class="btn"
            disabled={busy || (!running && !paused)}
            onClick={onPauseResume}
            aria-busy={pending === 'pauseResume'}
          >
            {pending === 'pauseResume'
              ? 'Working…'
              : paused
                ? 'Resume'
                : 'Pause'}
          </button>
        )}
        <button
          class="btn btn--stop"
          disabled={busy || (!running && !paused)}
          onClick={onStop}
          aria-busy={pending === 'stop'}
        >
          {pending === 'stop' ? 'Stopping…' : 'Stop'}
        </button>
      </div>

      {reason ? <div class="controlbar__halt">{reason}</div> : null}
    </div>
  );
}
