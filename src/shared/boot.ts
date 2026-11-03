/**
 * Launch readiness (spec §12.8, Appendix C.1): the boot view that rides
 * `EpoStatus.boot`, and the startup step shape every wiring module returns.
 * Pure, renderer-safe types.
 */

/** The startup sequence's steps, in their fixed order. */
export type StartupStepName = 'open-own-profile' | 'confirm-account' | 'catch-up' | 'resume-run';

/** Why the knowledge store could not open. */
export type BootDataProblem = 'future-version' | 'unreadable' | 'locked';

/** One step of the startup sequence (the boot sequencer runs them in order under the startup lease). */
export interface StartupStep {
  readonly name: StartupStepName;
  /** Evaluated just before the step runs. */
  when(): boolean;
  /** Owns its bounds; rejects only on an unexpected failure (logged). */
  run(signal: AbortSignal): Promise<void>;
}

export interface BootView {
  readonly phase: 'starting' | 'ready' | 'live';
  readonly identity: 'pending' | 'signed-in' | 'signed-out';
  readonly data: 'pending' | 'open' | 'not-applicable' | 'unavailable';
  readonly dataProblem: BootDataProblem | null;
  /** The IG tab's first navigation. */
  readonly tab: 'loading' | 'settled' | 'failed';
  /** The landing and account confirmation done behind the splash, or the reveal proceeds onto the placeholder. */
  readonly ig: 'pending' | 'ready' | 'placeholder';
  /** Main-process boot instant (epoch ms). */
  readonly startedAt: number;
  /** Reveal no later than this, ready or not. */
  readonly revealBy: number;
  readonly startup: {
    /** The running step; null when none runs. */
    readonly step: StartupStepName | null;
    /** A user Start waits for the sequence. */
    readonly startQueued: boolean;
    readonly done: boolean;
  };
}
