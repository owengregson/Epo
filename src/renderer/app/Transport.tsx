/** @jsx h */
import { h } from 'preact';
import type { EpoStatus } from '@/types';
import { Icon } from '../ui/Icon';

type EngineState = EpoStatus['state'];

export interface TransportProps {
  state: EngineState | undefined;
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
 */
export function Transport({ state, pending, onStart, onPauseResume, onCancel }: TransportProps): h.JSX.Element {
  const running = state === 'running';
  const paused = state === 'paused';
  const busy = pending != null;

  const startSpin = pending === 'start' || (paused && pending === 'pauseResume');
  const pauseSpin = !paused && pending === 'pauseResume';
  const cancelSpin = pending === 'stop';

  return (
    <div class="transport" role="group" aria-label="Engine transport" data-tour="transport">
      <button
        class="tbtn"
        id="btnStart"
        type="button"
        title={paused ? 'Resume the engine' : 'Start the engine'}
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
        title="Pause after the current action"
        disabled={!running || busy}
        onClick={onPauseResume}
      >
        <Icon name={pauseSpin ? 'spinner' : 'pause'} spin={pauseSpin} />
        <span class="tlabel">Pause</span>
      </button>

      <button
        class="tbtn danger"
        id="btnStop"
        type="button"
        title="Cancel the session"
        disabled={!(running || paused) || busy}
        onClick={onCancel}
      >
        <Icon name={cancelSpin ? 'spinner' : 'xmark'} spin={cancelSpin} />
        <span class="tlabel">Cancel</span>
      </button>
    </div>
  );
}
