import { type JSX } from 'preact';
import type { EngineState, TransportDriver } from '@/renderer/lib/engine-view';
import { Icon } from '@/renderer/ui/Icon';

export interface TransportProps {
  /** The UNIFIED console state (see `transportModel` in lib/engine-view.ts). */
  state: EngineState | undefined;
  /** Which driver the trio controls ('prune' while a prune holds the tab). */
  driver: TransportDriver;
  /** Prune is walking lists — no between-action boundary, so Pause locks. */
  pruneScanning: boolean;
  /** Name of the in-flight control ('start' | 'pauseResume' | 'stop'), or null. */
  pending: string | null;
  onStart(): void;
  onPauseResume(): void;
  onCancel(): void;
}

/**
 * The Start / Pause·Resume / Cancel trio. The cluster IS the state readout: the
 * "natural next control" for the current engine state carries the brushed sheen
 * (driven by `.console[data-state]` in CSS), so the buttons themselves narrate.
 * ONE trio serves BOTH drivers: while a prune holds the tab the same buttons
 * pause/resume/stop the prune, with their titles saying so.
 */
export function Transport({
  state,
  driver,
  pruneScanning,
  pending,
  onStart,
  onPauseResume,
  onCancel,
}: TransportProps): JSX.Element {
  const running = state === 'running';
  const paused = state === 'paused';
  const busy = pending != null;
  const prune = driver === 'prune';

  const startSpin = pending === 'start' || (paused && pending === 'pauseResume');
  const pauseSpin = !paused && pending === 'pauseResume';
  const cancelSpin = pending === 'stop';

  return (
    <div class="transport" role="group" aria-label="Engine transport" data-tour="transport">
      <button
        class="tbtn"
        id="btnStart"
        type="button"
        title={
          paused ? (prune ? 'Resume the prune' : 'Resume the engine') : 'Start the engine'
        }
        disabled={running || busy}
        onClick={paused ? onPauseResume : onStart}
      >
        <Icon name={startSpin ? 'spinner' : 'play'} spin={startSpin} />
        <span class="tlabel">{paused ? 'Resume' : 'Start'}</span>
      </button>

      <button
        class="tbtn"
        id="btnPause"
        type="button"
        title={
          prune
            ? pruneScanning
              ? 'A scan stops clean — use Cancel'
              : 'Pause the prune after the current unfollow'
            : 'Pause after the current action'
        }
        disabled={!running || busy || (prune && pruneScanning)}
        onClick={onPauseResume}
      >
        <Icon name={pauseSpin ? 'spinner' : 'pause'} spin={pauseSpin} />
        <span class="tlabel">Pause</span>
      </button>

      <button
        class="tbtn danger"
        id="btnStop"
        type="button"
        title={prune ? 'Stop the prune' : 'Cancel the session'}
        disabled={!(running || paused) || busy}
        onClick={onCancel}
      >
        <Icon name={cancelSpin ? 'spinner' : 'xmark'} spin={cancelSpin} />
        <span class="tlabel">Cancel</span>
      </button>
    </div>
  );
}
