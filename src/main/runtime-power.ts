/**
 * Own the unattended run's power assertion and system power subscriptions.
 * Keep the assertion until app teardown: even a parked engine has durable
 * schedules to wake for. Display sleep is allowed; forced sleep/lid close is
 * handled by the Foundation's freeze/revalidate sequence, never prevented here.
 */

import type { PowerSaveBlocker } from 'electron';
import * as logger from '@/utils/logger';

export interface RuntimePowerDependencies {
  blocker: Pick<PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>;
  monitor: {
    on(event: 'suspend' | 'resume', listener: () => void): unknown;
    removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
  };
  suspend(): void;
  resume(): Promise<void>;
}

export class RuntimePower {
  private blockerId: number | null = null;
  private disposed = false;
  private suspended = false;
  private watching = false;

  constructor(private readonly deps: RuntimePowerDependencies) {}

  /** Must be called after Electron's ready event. Idempotent while alive. */
  start(): void {
    if (this.disposed) return;
    this.ensureBlocker();
    if (this.watching) return;
    this.watching = true;
    this.deps.monitor.on('suspend', this.onSuspend);
    this.deps.monitor.on('resume', this.onResume);
  }

  /** Stop event delivery before asynchronous graph teardown begins. */
  stopWatching(): void {
    if (!this.watching) return;
    this.watching = false;
    this.deps.monitor.removeListener('suspend', this.onSuspend);
    this.deps.monitor.removeListener('resume', this.onResume);
  }

  /** Release the exact assertion we own once graph and tab teardown finish. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWatching();
    if (this.blockerId !== null) {
      this.deps.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  private ensureBlocker(): void {
    if (this.blockerId !== null && this.deps.blocker.isStarted(this.blockerId)) return;
    this.blockerId = this.deps.blocker.start('prevent-app-suspension');
    logger.info('runtime: background power assertion acquired', { id: this.blockerId });
  }

  private readonly onSuspend = (): void => {
    if (this.disposed || !this.watching || this.suspended) return;
    // Duplicate suspend notifications must not overwrite the Foundation's
    // remembered running state after its first stop has made the engine idle.
    this.suspended = true;
    logger.warn('main: system suspend');
    this.deps.suspend();
  };

  private readonly onResume = (): void => {
    if (this.disposed || !this.watching) return;
    this.suspended = false;
    try {
      this.ensureBlocker();
    } catch (error) {
      logger.error('runtime: background power assertion failed after resume', {
        error: String(error),
      });
    }
    logger.warn('main: system resumed');
    // EventEmitter does not observe async listener rejections. Disposal can
    // abort the wake delay, and failed canaries can reject, so consume both.
    void this.deps.resume().catch((error: unknown) => {
      logger.error('main: wake sequence failed', { error: String(error) });
    });
  };
}
