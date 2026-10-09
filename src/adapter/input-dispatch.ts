import { ActionAbortedError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import type { PointerInputEvent } from '@/interaction/input-driver';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';

/** A bounded, acknowledged queue. Old document/session input is never replayed. */
export class InputDispatch {
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;

  constructor(
    private readonly dispatch: (event: PointerInputEvent, isCurrent: () => boolean) => Promise<void>,
    private readonly timeoutMs: number,
    private readonly failed: (error: unknown) => void,
  ) {}

  invalidate(): void {
    this.epoch += 1;
    this.tail = Promise.resolve();
  }

  version(): number {
    return this.epoch;
  }

  send(event: PointerInputEvent): Promise<void> {
    const epoch = this.epoch;
    const operation = this.tail.then(async () => {
      if (epoch !== this.epoch) throw new ActionAbortedError('input:stale-document');
      try {
        const result = await withTimeout(this.dispatch(event, () => epoch === this.epoch), this.timeoutMs);
        if (result === TIMED_OUT) {
          // A press/release may have reached the page despite a lost ACK. The
          // existing recovery machinery must re-observe before trying again.
          throw new TabUnresponsiveError('input', this.timeoutMs,
            event.type === 'mouseDown' || event.type === 'mouseUp' ? 'post-click' : undefined);
        }
        if (epoch !== this.epoch) {
          if (event.type === 'mouseDown' || event.type === 'mouseUp') {
            throw new TabUnresponsiveError('input:document-changed-after-press', this.timeoutMs, 'post-click');
          }
          throw new ActionAbortedError('input:stale-document');
        }
      } catch (error) {
        let reported = error;
        if ((event.type === 'mouseDown' || event.type === 'mouseUp')
          && !(error instanceof ActionAbortedError) && !(error instanceof TabUnavailableError)
          && !(error instanceof TabUnresponsiveError)) {
          reported = new TabUnresponsiveError('input:ack-failed', this.timeoutMs, 'post-click');
          (reported as Error).cause = error;
        }
        if (epoch === this.epoch) {
          this.invalidate();
          this.failed(reported);
        }
        throw reported;
      }
    });
    // Keep the queue usable and handle ignored diagnostic calls, while returning
    // the ORIGINAL rejection to gesture callers so they stop immediately.
    this.tail = operation.catch(() => {});
    return operation;
  }
}
