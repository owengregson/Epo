/**
 * The in-process log ring (spec §12.9, Appendix C.3): the newest lines the logger emitted, for the Diagnostics
 * panel's first pull (`logTail`); the `log` push streams only while a panel asks for it (owner Q30 default).
 * `logs/runtime.jsonl` stays the durable record.
 */

import type { LogEntry } from '@/shared/log-entry';

export class LogRing {
  private readonly lines: LogEntry[] = [];
  private live = false;

  /** `capacity` is `DIAGNOSTICS.LOG_RING`. */
  constructor(private readonly capacity: number) {}

  add(entry: LogEntry): void {
    this.lines.push(entry);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  /** The kept lines, oldest first, as a copy. */
  tail(): LogEntry[] {
    return [...this.lines];
  }

  /** A Diagnostics panel mounted (true) or unmounted (false). */
  setStreaming(on: boolean): void {
    this.live = on;
  }

  streaming(): boolean {
    return this.live;
  }
}
