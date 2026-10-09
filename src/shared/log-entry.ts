/**
 * The structured log stream (main → renderer): one line as the logger emits it
 * and the log pane renders it. Pure value types — the `log` push channel's
 * payload (`src/ipc/contract.ts`), named here so neither side imports the other.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  meta?: unknown;
  /** Epoch milliseconds when the entry was emitted. */
  at: number;
}
