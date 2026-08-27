/**
 * Connectivity monitor (main process).
 *
 * Periodically probes a lightweight, cache-free endpoint through Electron's
 * `net.request` (main-process networking — not CSP-bound, and it shares the OS
 * proxy/DNS stack the embedded tab uses) and reports transitions to a single
 * `onChange` callback. The Foundation wires that callback to
 * `Engine.setOnline`, which parks/resumes the run loop.
 *
 * Guarantees:
 *  - `check()` never throws: any error / timeout / abort resolves to `false`.
 *  - `onChange` fires once on the FIRST resolved check, then only on change.
 *  - Checks never overlap; `stop()` clears the timer and aborts any in-flight
 *    request.
 */

import type { ClientRequest } from 'electron';
import { net } from 'electron';
import { SystemClock } from '@/governors/clock';
import { CONNECTIVITY } from '@/timing/config';
import { ScheduleManager } from '@/timing/schedule-manager';
import * as log from '@/utils/logger';

/** Returns 204 with an empty body — the canonical connectivity probe. */
const PROBE_URL = 'https://www.gstatic.com/generate_204';

export class ConnectivityMonitor {
  private readonly onChange: (online: boolean) => void;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  /** The probe loop rides ScheduleManager: its overlap guard drops (never
   *  stacks) a tick landing while a probe is still in flight — replacing the
   *  old hand-rolled `checking` flag. */
  private readonly scheduler = new ScheduleManager({ clock: new SystemClock() });
  private started = false;
  /** Last resolved state; null until the first check settles. */
  private lastOnline: boolean | null = null;
  private inFlight: ClientRequest | null = null;
  private stopped = false;

  constructor(
    onChange: (online: boolean) => void,
    opts?: { intervalMs?: number; timeoutMs?: number },
  ) {
    this.onChange = onChange;
    this.intervalMs = opts?.intervalMs ?? CONNECTIVITY.PROBE_INTERVAL_MS;
    this.timeoutMs = opts?.timeoutMs ?? CONNECTIVITY.REQUEST_TIMEOUT_MS;
  }

  /** Immediate check, then every `intervalMs`. Idempotent while running. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.scheduler.every('connectivity:probe', this.intervalMs, () => this.check(), {
      immediate: true,
    });
  }

  /** Stop the loop and abort any in-flight probe. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.started = false;
    this.scheduler.stop('connectivity:probe');
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /** One probe; reports to `onChange` on the first result and on every change. */
  private async check(): Promise<void> {
    const online = await this.probe();
    if (this.stopped) return;
    if (this.lastOnline !== online) {
      this.lastOnline = online;
      log.info('connectivity: state resolved', { online });
      this.onChange(online);
    }
  }

  /** Never rejects: any 2xx response is `true`; error/timeout/abort is `false`. */
  private probe(): Promise<boolean> {
    // Short-circuit: when Chromium already knows every interface is down, the
    // request could only fail — skip the network round trip.
    if (!net.isOnline()) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let request: ClientRequest;
      try {
        request = net.request({ method: 'GET', url: PROBE_URL });
      } catch (e) {
        log.warn('connectivity: probe request could not start', { error: String(e) });
        resolve(false);
        return;
      }

      let settled = false;
      const finish = (online: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.inFlight === request) this.inFlight = null;
        resolve(online);
      };

      // Enforce the timeout by aborting the request (net.request has none built in).
      const timeout = setTimeout(() => {
        log.debug('connectivity: probe timed out', { timeoutMs: this.timeoutMs });
        request.abort();
        finish(false);
      }, this.timeoutMs);

      this.inFlight = request;
      request.on('response', (response) => {
        finish(response.statusCode >= 200 && response.statusCode < 300);
        // Drain (and ignore) the body so the socket is released; generate_204's
        // body is empty anyway.
        response.on('data', () => {});
        response.on('error', () => {
          log.debug('connectivity: probe body errored after response');
        });
      });
      request.on('error', (err) => {
        log.debug('connectivity: probe failed', { error: String(err) });
        finish(false);
      });
      request.on('abort', () => finish(false));
      request.end();
    });
  }
}
