/**
 * Own the persistent Instagram WebContentsView, acknowledged input and health.
 * Observe CDP Network responses on loadingFinished so getResponseBody is ready.
 * Electron webRequest exposes metadata only; CDP supplies decoded bodies.
 */

import type {
  BaseWindow,
  Debugger,
  Event as ElectronEvent,
  WebContents,
} from 'electron';
import { app, session, WebContentsView } from 'electron';
import { browserUserAgent } from '@/adapter/browser-identity';
import { prepareClickGuard } from '@/adapter/click-guard';
import { ActionAbortedError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { SURFACE } from '@/adapter/ig-surface';
import { InputDispatch } from '@/adapter/input-dispatch';
import { pageCall } from '@/adapter/page-call';
import { assessRendererCanary, rendererCanaryScript } from '@/adapter/renderer-canary';
import { TabPlacement } from '@/adapter/tab-placement';
import { toCdpMouseParams } from '@/interaction/cdp-input';
import type { PointerInputEvent } from '@/interaction/input-driver';
import type { ClickGuard } from '@/interaction/interactor';
import type { ElementRect, Point } from '@/interaction/motion-profile';
import { SURFACE_METER } from '@/surface/meter';
import { INPUT_PROBE, RECOVERY, TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import type { ResponseHandler, TabResponse, Unsubscribe } from '@/types';
import * as logger from '@/utils/logger';

/** Persistent session partition — login state is durable across restarts. */
export const IG_PARTITION = 'persist:ig';

/** Instagram home; the login flow is completed by the user in the tab. */
export const IG_HOME_URL = `${SURFACE.origin}/`;

/** Historical capture identity; runtime identity comes from native Chromium. */
export const IG_USER_AGENT = SURFACE.userAgent;

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Metadata captured at `Network.requestWillBeSent`, keyed by CDP requestId. */
interface PendingRequest {
  method: string;
  /** Header names lower-cased — consumers never depend on the page's casing. */
  headers: Record<string, string>;
}

/** Metadata captured at `Network.responseReceived`, keyed by CDP requestId. */
interface PendingResponse {
  url: string;
  status: number;
  mimeType: string;
  request?: PendingRequest;
}

/**
 * Deadlines on the tab-facing awaits (`goto` / `evaluate` / `getBody`). A
 * wedged webContents can leave any of these promises pending FOREVER —
 * every one is raced against its deadline and surfaces as a typed
 * `TabUnresponsiveError` instead of parking the caller. Injectable so tests
 * exercise the timeout paths without waiting out the production values.
 */
export interface TabTimeouts {
  gotoMs: number;
  evaluateMs: number;
  getBodyMs: number;
  inputMs: number;
}

export interface InstagramTabOptions {
  /** Overrides for the tab-facing await deadlines; defaults come from `TAB.*`. */
  timeouts?: Partial<TabTimeouts>;
}

export class InstagramTab {
  private readonly view: WebContentsView;
  private readonly contents: WebContents;
  private readonly placement: TabPlacement;
  private readonly responseHandlers = new Set<ResponseHandler>();
  private readonly pending = new Map<string, PendingResponse>();
  /** Requests seen going out, awaiting their response (released on finish/fail). */
  private readonly requests = new Map<string, PendingRequest>();
  private readonly timeouts: TabTimeouts;
  private debuggerReady = false;
  private readonly input: InputDispatch;
  private debuggerSetup: Promise<void> = Promise.resolve();
  private debuggerEpoch = 0;
  private bounds: Rectangle | null = null;
  /**
   * Set when a health event fires (debugger detach, renderer gone/unresponsive,
   * input-dispatch fallback); cleared only by a completed {@link recoverTab}.
   * {@link checkHealth} folds it in, so every diagnostic path routes to
   * recovery even when the renderer's rAF still ticks.
   */
  private unhealthyReason: string | null = null;
  /** Health-event policy callback — the composition root owns recovery. */
  private onUnhealthyCb: ((reason: string) => void) | null = null;
  /** A refused input dispatch fires ONE health event per attach epoch. */
  private inputUnavailableReported = false;

  constructor(opts: InstagramTabOptions = {}) {
    this.timeouts = {
      gotoMs: opts.timeouts?.gotoMs ?? TAB.GOTO_TIMEOUT_MS,
      evaluateMs: opts.timeouts?.evaluateMs ?? TAB.EVALUATE_TIMEOUT_MS,
      getBodyMs: opts.timeouts?.getBodyMs ?? TAB.GET_BODY_TIMEOUT_MS,
      inputMs: opts.timeouts?.inputMs ?? TAB.EVALUATE_TIMEOUT_MS,
    };
    this.input = new InputDispatch(
      (event, isCurrent) => this.dispatchInput(event, isCurrent),
      this.timeouts.inputMs,
      (error) => {
        if (!this.inputUnavailableReported) {
          this.inputUnavailableReported = true;
          this.markUnhealthy(error instanceof TabUnavailableError ? 'input-unavailable' : 'input-dispatch-failed');
        }
      },
    );
    const igSession = session.fromPartition(IG_PARTITION);
    const userAgent = browserUserAgent(igSession.getUserAgent());
    igSession.setUserAgent(userAgent, app.getPreferredSystemLanguages().join(','));
    this.view = new WebContentsView({
      webPreferences: {
        // Persistent, partitioned session: the whole point of Task 6.
        session: igSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Keep timers/input alive when hidden. On macOS the renderer needs a
        // local frame source after hidden navigation (otherwise CDP ACKs take
        // ~1 s). Scope that switch HERE: setting it on app.commandLine also
        // disables shared GPU vsync and uncaps the dashboard/veil, causing lag.
        additionalArguments: process.platform === 'darwin' ? ['--disable-frame-rate-limit'] : [],
        backgroundThrottling: false,
      },
    });
    this.contents = this.view.webContents;
    this.contents.setUserAgent(userAgent);
    this.placement = new TabPlacement(this.view);
  }

  /** Attach the tab to a host window and begin observing network traffic. */
  attach(win: BaseWindow): void {
    this.placement.attach(win);
    // Health eventing — registered ONCE per webContents (a reload keeps the
    // same webContents, so recoverTab never needs to re-register these). A
    // crashed or hung renderer must surface as an EVENT the composition root
    // routes to recovery, never as a silently-dead onResponse stream.
    const wc = this.contents;
    wc.on('render-process-gone', (_event, details) => {
      this.debuggerReady = false;
      this.debuggerEpoch += 1;
      this.input.invalidate();
      this.markUnhealthy(`render-process-gone:${details.reason}`);
    });
    wc.on('unresponsive', () => {
      this.markUnhealthy('unresponsive');
    });
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame) this.input.invalidate();
    });
    this.attachDebugger();
  }

  /**
   * Health-event callback: fired when the tab detects its own machinery is
   * compromised — the CDP debugger detached (onResponse consumers observe
   * NOTHING from then on), the renderer crashed or hung, or an input dispatch
   * was REFUSED because the debugger (the only click path — ADR 0305/0805) is
   * gone. The tab only REPORTS; recovery policy belongs to the caller.
   */
  onUnhealthy(cb: (reason: string) => void): void {
    this.onUnhealthyCb = cb;
  }

  /** True while a health event stands un-repaired (no recoverTab since). */
  isMarkedUnhealthy(): boolean {
    return this.unhealthyReason !== null;
  }

  private markUnhealthy(reason: string): void {
    this.input.invalidate();
    this.unhealthyReason = reason;
    logger.error('tab: unhealthy', { reason });
    try {
      this.onUnhealthyCb?.(reason);
    } catch (e) {
      logger.error('tab.onUnhealthy callback threw', { reason, error: String(e) });
    }
  }

  /** Position the tab within the host window. */
  setBounds(bounds: Rectangle): void {
    if (this.bounds?.width !== bounds.width || this.bounds?.height !== bounds.height) this.input.invalidate();
    this.bounds = { ...bounds };
    this.view.setBounds(bounds);
  }

  /** Reveal the tab. */
  show(): void {
    this.placement.show();
  }

  /** Conceal below the opaque dashboard, keeping native input dispatch alive. */
  hide(): void {
    this.placement.hide();
  }

  /**
   * The tab's LIVE webContents, guarded. Throws {@link TabUnavailableError}
   * when the webContents was destroyed or never initialized, so callers
   * classify a torn-down tab by TYPE instead of a cryptic `Cannot read
   * properties of undefined` (or a string match on the message).
   */
  private liveContents(): WebContents {
    const wc = this.contents;
    if (!wc || wc.isDestroyed()) throw new TabUnavailableError('instagram-tab');
    return wc;
  }

  /**
   * Navigate the tab to a URL (e.g. Instagram home for login). Deadline-bounded:
   * a navigation that never settles (wedged renderer) throws
   * `TabUnresponsiveError` instead of parking the caller forever.
   */
  async goto(url: string): Promise<void> {
    logger.info('tab.goto', { url });
    this.input.invalidate();
    try {
      // Start the first renderer before awaiting CDP setup (cold views have none).
      const settled = await withTimeout(this.liveContents().loadURL(url), this.timeouts.gotoMs);
      if (settled === TIMED_OUT) {
        throw new TabUnresponsiveError('goto', this.timeouts.gotoMs);
      }
      await this.debuggerSetup;
    } catch (e) {
      // ERR_ABORTED (-3) means the navigation was superseded — a concurrent
      // loadURL (e.g. the startup nav racing the build-flow's username resolve)
      // or an Instagram client-side redirect. The winning navigation is the one
      // that matters, so this is benign; rethrow anything else (a timeout falls
      // through here unmatched and stays a loud TabUnresponsiveError).
      const err = e as { code?: string; errno?: number };
      if (err && (err.code === 'ERR_ABORTED' || err.errno === -3)) {
        logger.debug('tab.goto: navigation superseded (ERR_ABORTED), ignoring', { url });
        return;
      }
      throw e;
    }
  }

  /**
   * The tab's current URL (used by the Sentinel for logged-out redirects). A
   * query, not an operation, so it degrades to an empty string when the
   * webContents is unavailable rather than throwing into every caller's path.
   */
  currentUrl(): string {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return '';
    return wc.getURL();
  }

  /**
   * Evaluate code in the tab's page context.
   *
   * Accepts either a source string or a zero-arg function (which is serialized
   * and invoked as an IIFE). The result is whatever the expression resolves to,
   * structured-cloned back across the boundary. Deadline-bounded: an
   * `executeJavaScript` that never settles throws `TabUnresponsiveError`.
   */
  async evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T> {
    const code =
      typeof fnOrString === 'function'
        ? `(${fnOrString.toString()})()`
        : fnOrString;
    const result = await withTimeout(
      this.liveContents().executeJavaScript(code, false) as Promise<T>,
      this.timeouts.evaluateMs,
    );
    if (result === TIMED_OUT) {
      throw new TabUnresponsiveError('evaluate', this.timeouts.evaluateMs);
    }
    return result;
  }

  /** Acknowledged CDP input; never fall back to focus-dependent Electron input. */
  sendInputEvent(event: PointerInputEvent): Promise<void> {
    return this.input.send(event);
  }

  /** Captured by each gesture; navigation/recovery invalidates its coordinates. */
  inputVersion(): number {
    return this.input.version();
  }

  canClick(target: ElementRect, point: Point): Promise<boolean> {
    return this.evaluate<boolean>(pageCall('canClick', { target, point }));
  }

  prepareClick(target: ElementRect, point: Point): Promise<ClickGuard> {
    const version = this.input.version();
    return prepareClickGuard(async (method, params) => {
      await this.debuggerSetup;
      if (method !== 'Runtime.releaseObject' && version !== this.input.version()) throw new ActionAbortedError('input:stale-document');
      const result = await withTimeout(this.liveContents().debugger.sendCommand(method, params), this.timeouts.evaluateMs);
      if (result === TIMED_OUT) throw new TabUnresponsiveError('click-target', this.timeouts.evaluateMs);
      return result;
    }, target, point);
  }

  private async dispatchInput(event: PointerInputEvent, isCurrent: () => boolean): Promise<void> {
    await this.debuggerSetup;
    if (!isCurrent()) throw new ActionAbortedError('input:stale-document');
    const dbg = this.liveContents().debugger;
    if (!this.debuggerReady || !dbg.isAttached() || this.unhealthyReason !== null) {
      throw new TabUnavailableError('input');
    }
    await dbg.sendCommand('Input.dispatchMouseEvent', toCdpMouseParams(event));
  }

  /**
   * Diagnostic: capture the tab's current visual state as a PNG buffer.
   * Used by debug harnesses (and available to future triage paths) to SEE
   * what was on screen when an expected control was missing.
   */
  async captureScreenshot(): Promise<Buffer> {
    const image = await this.liveContents().capturePage();
    return image.toPNG();
  }

  /** Diagnostic round-trip through the same input pipeline as the Interactor. */
  async probeInput(): Promise<boolean> {
    try {
      await this.evaluate(
        `(() => {
          window.__epoInputProbe = false;
          document.addEventListener(
            'mousemove',
            () => { window.__epoInputProbe = true; },
            { once: true, capture: true },
          );
          return true;
        })()`,
      );
      await this.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
      for (let i = 0; i < INPUT_PROBE.ROUNDS; i++) {
        await new Promise((r) => setTimeout(r, INPUT_PROBE.INTERVAL_MS));
        const got = await this.evaluate(
          'window.__epoInputProbe === true',
        );
        if (got === true) return true;
      }
      return false;
    } catch (e) {
      logger.warn('tab.probeInput failed', { error: String(e) });
      return false;
    }
  }

  /** Renderer canary: bounded evaluate + rAF progress and standing health marks. */
  async checkHealth(
    windowMs: number = RECOVERY.CANARY_WINDOW_MS,
  ): Promise<{ healthy: boolean; evaluateOk: boolean; rafTicks: number }> {
    try {
      const echo = await this.evaluate<number>('1 + 1');
      if (echo !== 2) return { healthy: false, evaluateOk: false, rafTicks: 0 };
      const canary = assessRendererCanary(await this.evaluate<unknown>(rendererCanaryScript(windowMs)));
      // A standing health mark (debugger detached, renderer gone, input
      // refused) is unhealthy even while rAF still ticks: the CDP layer the
      // Reader and input dispatch ride is gone until recoverTab re-arms it.
      return {
        healthy: canary.healthy && this.unhealthyReason === null,
        evaluateOk: true,
        rafTicks: canary.rafTicks,
      };
    } catch (e) {
      logger.warn('tab.checkHealth failed', { error: String(e) });
      return { healthy: false, evaluateOk: false, rafTicks: 0 };
    }
  }

  /**
   * Observe network responses. Returns a disposer that removes the handler.
   * The Reader (Task 7) registers here and calls `getBody()` only on the
   * responses whose URL matches an Instagram endpoint it cares about.
   */
  onResponse(handler: ResponseHandler): Unsubscribe {
    this.responseHandlers.add(handler);
    return () => {
      this.responseHandlers.delete(handler);
    };
  }

  /** Diagnostic: requests observed going out that have not finished or failed yet. */
  pendingRequestCount(): number {
    return this.requests.size;
  }

  /**
   * Recover a wedged tab: drop the CDP session, reload the page, and re-attach
   * the debugger (Network domain + focus emulation) so network observation and
   * input dispatch come back on the fresh renderer. Called by the main-process
   * step watchdog after it detects a stalled run. Every wait inside is
   * deadline-bounded, so recovery itself can never hang.
   */
  async recoverTab(): Promise<void> {
    const wc = this.liveContents();
    this.input.invalidate();
    this.debuggerEpoch += 1;
    logger.warn('tab.recoverTab: reloading webContents and re-attaching debugger');
    this.pending.clear();
    this.requests.clear();
    const dbg = wc.debugger;
    // A DELIBERATE detach must not fire the unhealthy event this recovery is
    // here to repair — drop the detach listener before detaching.
    dbg.removeListener('detach', this.onDebuggerDetach);
    if (dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (e) {
        logger.warn('tab.recoverTab: debugger detach failed', { error: String(e) });
      }
    }
    // Drop our message listener before `attachDebugger` re-registers it —
    // detach does not clear emitter listeners, and a double registration
    // would emit every response twice.
    dbg.removeListener('message', this.onDebuggerMessage);
    this.debuggerReady = false;

    // Reload, waiting (bounded) for the load to settle. `did-stop-loading`
    // fires on success AND failure; a renderer too wedged to emit even that
    // just runs out the deadline and we re-attach anyway.
    const onLoadStop = { fn: (): void => {} };
    const loaded = new Promise<void>((resolve) => {
      onLoadStop.fn = (): void => resolve();
      wc.once('did-stop-loading', onLoadStop.fn);
    });
    wc.reload();
    const settled = await withTimeout(loaded, this.timeouts.gotoMs);
    if (settled === TIMED_OUT) {
      wc.removeListener('did-stop-loading', onLoadStop.fn);
      this.markUnhealthy('recovery-reload-timeout');
      throw new TabUnresponsiveError('recovery-reload', this.timeouts.gotoMs);
    }
    this.attachDebugger();
    await this.debuggerSetup;
    // Re-armed: attachDebugger re-registered the detach + message listeners
    // and re-enabled Network + focus emulation on the fresh session. Clear the
    // health marks so the NEXT event (including a fresh input fallback in the
    // new epoch) reports again instead of being swallowed as already-known.
    this.unhealthyReason = null;
    this.inputUnavailableReported = false;
  }

  /** Detach the debugger and release the network observer. Idempotent. */
  dispose(): void {
    this.placement.dispose();
    this.input.invalidate();
    this.debuggerEpoch += 1;
    this.responseHandlers.clear();
    this.pending.clear();
    this.requests.clear();
    // Teardown detach is deliberate — never a health event.
    this.onUnhealthyCb = null;
    if (this.contents.isDestroyed()) return;
    const dbg = this.contents.debugger;
    dbg.removeListener('detach', this.onDebuggerDetach);
    if (dbg.isAttached()) {
      try {
        dbg.detach();
      } catch (e) {
        logger.warn('tab.debugger.detach failed', { error: String(e) });
      }
    }
    this.debuggerReady = false;
  }

  // -------------------------------------------------------------------------
  // CDP network observation
  // -------------------------------------------------------------------------

  private attachDebugger(): void {
    const epoch = ++this.debuggerEpoch;
    this.debuggerReady = false;
    const dbg = this.contents.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach('1.3');
      } catch (e) {
        // Loud, never silent: without CDP the Reader has no data source.
        logger.error('tab.debugger.attach failed', { error: String(e) });
        this.markUnhealthy('debugger-attach-failed');
        this.debuggerSetup = Promise.reject(e);
        void this.debuggerSetup.catch(() => {});
        return;
      }
    }
    // Idempotent (re-)registration — remove-then-add: recoverTab re-enters
    // here after a reload, and a doubled listener would emit every response
    // (and every detach) twice. The 'detach' listener MUST ride every
    // (re-)attach: an event-loop detach (renderer crash under background
    // memory pressure, sleep-resume teardown, a DevTools conflict) otherwise
    // kills onResponse + CDP input silently, forever.
    dbg.removeListener('message', this.onDebuggerMessage);
    dbg.removeListener('detach', this.onDebuggerDetach);
    dbg.on('detach', this.onDebuggerDetach);
    dbg.on('message', this.onDebuggerMessage);
    // The page always believes it is focused (Playwright's default): an
    // unfocused window otherwise fires window blur handlers that some SPAs
    // use to pause work. Best-effort — input and reads work without it.
    // Re-applied on every (re-)attach, so a debugger re-creation restores it.
    this.debuggerSetup = (async () => {
      try {
        const result = await withTimeout(Promise.all([
          dbg.sendCommand('Network.enable'),
          dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }),
        ]), this.timeouts.evaluateMs);
        if (result === TIMED_OUT) throw new TabUnresponsiveError('debugger-setup', this.timeouts.evaluateMs);
        if (epoch !== this.debuggerEpoch || !dbg.isAttached()) throw new TabUnavailableError('debugger-setup');
        this.debuggerReady = true;
        logger.debug('tab.debugger attached; Network and focus enabled');
      } catch (error) {
        if (epoch === this.debuggerEpoch) this.markUnhealthy('debugger-setup-failed');
        throw error;
      }
    })();
    void this.debuggerSetup.catch(() => {});
  }

  /**
   * Chromium terminated the CDP session out from under us: from this moment
   * onResponse consumers observe NOTHING (no error — the stream just goes
   * quiet) and every input dispatch is REFUSED, so this is a health EVENT.
   * Deliberate detaches (recoverTab / dispose) remove this listener first.
   */
  private readonly onDebuggerDetach = (_event: ElectronEvent, reason: string): void => {
    this.debuggerReady = false;
    this.debuggerEpoch += 1;
    this.input.invalidate();
    this.pending.clear();
    this.requests.clear();
    this.markUnhealthy(`debugger-detach:${reason}`);
  };

  private readonly onDebuggerMessage = (
    _event: ElectronEvent,
    method: string,
    params: unknown,
  ): void => {
    if (method === 'Network.requestWillBeSent') {
      // The request side: method + headers, so a response can be attributed
      // to the kind of request that produced it (a POST mutation vs a GET
      // read; a GraphQL mutation vs a query by its friendly-name header).
      const p = params as {
        requestId: string;
        request: { method?: string; headers?: Record<string, string> };
      };
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.request.headers ?? {})) {
        headers[k.toLowerCase()] = String(v);
      }
      this.requests.set(p.requestId, { method: p.request.method ?? 'GET', headers });
      return;
    }

    if (method === 'Network.responseReceived') {
      const p = params as {
        requestId: string;
        response: { url: string; status: number; mimeType: string };
      };
      const request = this.requests.get(p.requestId);
      this.requests.delete(p.requestId);
      this.pending.set(p.requestId, {
        url: p.response.url,
        status: p.response.status,
        mimeType: p.response.mimeType,
        request,
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const p = params as { requestId: string };
      const meta = this.pending.get(p.requestId);
      if (!meta) return;
      this.pending.delete(p.requestId);
      this.emitResponse(p.requestId, meta);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const p = params as { requestId: string };
      this.pending.delete(p.requestId);
      this.requests.delete(p.requestId);
    }
  };

  private emitResponse(requestId: string, meta: PendingResponse): void {
    if (this.responseHandlers.size === 0) return;
    const dbg = this.contents.debugger;
    const response: TabResponse = {
      requestId,
      url: meta.url,
      status: meta.status,
      mimeType: meta.mimeType,
      method: meta.request?.method,
      requestHeaders: meta.request?.headers,
      getBody: async () => {
        // Deadline-bounded: a CDP call against a wedged debugger session can
        // stay pending forever — surface that as `TabUnresponsiveError`.
        const startedAt = Date.now();
        const res = await withTimeout(
          dbg.sendCommand('Network.getResponseBody', { requestId }) as Promise<{
            body: string;
            base64Encoded: boolean;
          }>,
          this.timeouts.getBodyMs,
        );
        // Successful samples only: a timeout measures the deadline, not the trip.
        if (res === TIMED_OUT) throw new TabUnresponsiveError('getBody', this.timeouts.getBodyMs);
        SURFACE_METER.record('body-read', Date.now() - startedAt);
        return res.base64Encoded
          ? Buffer.from(res.body, 'base64').toString('utf8')
          : res.body;
      },
    };
    for (const handler of this.responseHandlers) {
      try {
        handler(response);
      } catch (e) {
        logger.error('tab.onResponse handler threw', {
          url: meta.url,
          error: String(e),
        });
      }
    }
  }
}

// Re-export the debugger type name so downstream typing stays local to adapter.
export type TabDebugger = Debugger;
