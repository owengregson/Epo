/**
 * InstagramTab — the embedded, visible Instagram browsing surface.
 *
 * Wraps an Electron `WebContentsView` on a PERSISTENT partitioned session
 * (`persist:ig`) so cookies/login survive app restarts. This is the single
 * place that owns the tab's lifecycle; the Adapter (Reader/Actor/Sentinel,
 * Tasks 7-8) drives Instagram exclusively through the methods exposed here.
 *
 * Network observation
 * -------------------
 * `onResponse` is implemented with the Chrome DevTools Protocol via
 * `webContents.debugger` (`Network.responseReceived` + `Network.getResponseBody`),
 * NOT `session.webRequest`. Rationale: Electron's `webRequest` API exposes
 * request/response *metadata* only and cannot read response BODIES, which the
 * Reader needs to parse Instagram's JSON/GraphQL payloads. CDP is the only
 * in-process mechanism that yields decoded bodies. We emit each response on
 * `Network.loadingFinished` (rather than `responseReceived`) so the body is
 * reliably available in the CDP resource cache when `getBody()` is called.
 */

import type {
  BaseWindow,
  Debugger,
  Event as ElectronEvent,
  WebContents,
} from 'electron';
import { session, WebContentsView } from 'electron';
import { TabUnresponsiveError } from '@/adapter/errors';
import { SURFACE } from '@/adapter/ig-surface';
import { toCdpMouseParams } from '@/interaction/cdp-input';
import type { PointerInputEvent } from '@/interaction/input-driver';
import { RECOVERY, TAB } from '@/timing/config';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import type { ResponseHandler, TabResponse, Unsubscribe } from '@/types';
import * as logger from '@/utils/logger';

/** Persistent session partition — login state is durable across restarts. */
export const IG_PARTITION = 'persist:ig';

/** Instagram home; the login flow is completed by the user in the tab. */
export const IG_HOME_URL = `${SURFACE.origin}/`;

/**
 * The genuine desktop Chrome User-Agent the active surface version pins.
 *
 * Electron's default UA advertises `Electron/<version>`, which Instagram's
 * private JSON endpoints reject with "useragent mismatch". We pin a real Chrome
 * UA on the persistent session so the intercepted API calls the Reader depends
 * on are accepted. It is re-verified (and bumped) with the surface version.
 */
export const IG_USER_AGENT = SURFACE.userAgent;

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Metadata captured at `Network.responseReceived`, keyed by CDP requestId. */
interface PendingResponse {
  url: string;
  status: number;
  mimeType: string;
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
}

export interface InstagramTabOptions {
  /** Overrides for the tab-facing await deadlines; defaults come from `TAB.*`. */
  timeouts?: Partial<TabTimeouts>;
}

export class InstagramTab {
  private readonly view: WebContentsView;
  private readonly responseHandlers = new Set<ResponseHandler>();
  private readonly pending = new Map<string, PendingResponse>();
  private readonly timeouts: TabTimeouts;
  private debuggerReady = false;
  /** Serializes CDP input dispatches so move/down/up order is guaranteed. */
  private inputChain: Promise<void> = Promise.resolve();

  constructor(opts: InstagramTabOptions = {}) {
    this.timeouts = {
      gotoMs: opts.timeouts?.gotoMs ?? TAB.GOTO_TIMEOUT_MS,
      evaluateMs: opts.timeouts?.evaluateMs ?? TAB.EVALUATE_TIMEOUT_MS,
      getBodyMs: opts.timeouts?.getBodyMs ?? TAB.GET_BODY_TIMEOUT_MS,
    };
    const igSession = session.fromPartition(IG_PARTITION);
    // Present as real desktop Chrome so IG's private JSON API doesn't reject
    // requests with "useragent mismatch". Set on the session (covers all
    // network requests) and on the webContents once it exists (below).
    igSession.setUserAgent(IG_USER_AGENT);
    this.view = new WebContentsView({
      webPreferences: {
        // Persistent, partitioned session: the whole point of Task 6.
        session: igSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Background-run survival (measured, 2026-08-14 input lab): without
        // this, a blurred/occluded/hidden/minimized window stops the page's
        // rAF entirely and clamps its timers ~15× — Instagram's SPA then
        // cannot hydrate or advance its UI, and every action times out even
        // though CDP input arrives. Together with the app-level switches in
        // `main.ts` this keeps the tab fully alive in every window state.
        backgroundThrottling: false,
      },
    });
    this.view.webContents.setUserAgent(IG_USER_AGENT);
  }

  /** Attach the tab to a host window and begin observing network traffic. */
  attach(win: BaseWindow): void {
    win.contentView.addChildView(this.view);
    this.attachDebugger();
  }

  /** Position the tab within the host window. */
  setBounds(bounds: Rectangle): void {
    this.view.setBounds(bounds);
  }

  /** Reveal the tab. */
  show(): void {
    this.view.setVisible(true);
  }

  /** Hide the tab (keeps the session and page alive). */
  hide(): void {
    this.view.setVisible(false);
  }

  /**
   * The tab's LIVE webContents, guarded. Throws a clear, catchable error when the
   * webContents was destroyed or never initialized — so callers log a meaningful
   * reason instead of a cryptic `Cannot read properties of undefined (reading
   * 'executeJavaScript')` when the tab is torn down (e.g. after a hard navigation
   * failure or during shutdown).
   */
  private liveContents(): WebContents {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) {
      throw new Error('instagram-tab: webContents unavailable (destroyed or not initialized)');
    }
    return wc;
  }

  /**
   * Navigate the tab to a URL (e.g. Instagram home for login). Deadline-bounded:
   * a navigation that never settles (wedged renderer) throws
   * `TabUnresponsiveError` instead of parking the caller forever.
   */
  async goto(url: string): Promise<void> {
    logger.info('tab.goto', { url });
    try {
      const settled = await withTimeout(this.liveContents().loadURL(url), this.timeouts.gotoMs);
      if (settled === TIMED_OUT) {
        throw new TabUnresponsiveError('goto', this.timeouts.gotoMs);
      }
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
      this.liveContents().executeJavaScript(code, true) as Promise<T>,
      this.timeouts.evaluateMs,
    );
    if (result === TIMED_OUT) {
      throw new TabUnresponsiveError('evaluate', this.timeouts.evaluateMs);
    }
    return result;
  }

  /**
   * Dispatch an input event (mouse move / down / up / wheel) into the tab's
   * webContents. The Interactor (`src/interaction/`) routes all of its gestures
   * through this single seam, and the tab stays the only Electron-touching layer.
   *
   * Transport is CDP `Input.dispatchMouseEvent` on the already-attached
   * debugger — NOT `webContents.sendInputEvent`, which Electron documents as
   * working only while the host window is FOCUSED. An unattended overnight run
   * keeps the window in the background, so under `sendInputEvent` every click
   * was silently dropped (the 2026-08-13 all-night run: every follow reported
   * `clicked: true` while the page never received a thing). CDP injection is
   * the Puppeteer/Playwright mechanism: trusted events, focus-independent, and
   * unaffected by the veil view stacked above the tab.
   *
   * Fire-and-forget by contract (the driver seam is synchronous), but events
   * are SERIALIZED through a promise chain so down/up ordering is preserved,
   * with failures logged. Falls back to `sendInputEvent` (focus-dependent) only
   * if the debugger is unavailable — in which case the Reader is dead anyway.
   */
  sendInputEvent(event: PointerInputEvent): void {
    this.inputChain = this.inputChain
      .then(async () => {
        const wc = this.liveContents();
        const dbg = wc.debugger;
        if (this.debuggerReady && dbg.isAttached()) {
          await dbg.sendCommand('Input.dispatchMouseEvent', toCdpMouseParams(event));
          return;
        }
        logger.warn('tab.sendInputEvent: debugger unavailable, falling back to sendInputEvent', {
          type: event.type,
        });
        wc.sendInputEvent(event);
      })
      .catch((e: unknown) => {
        logger.error('tab.sendInputEvent: input dispatch failed', {
          type: event.type,
          error: String(e),
        });
      });
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

  /**
   * Diagnostic: verify the input pipeline end-to-end. Installs a one-shot
   * mousemove listener in the page, dispatches a real input event through the
   * same seam the Interactor uses, and reports whether the page received it.
   * Called when the engine halts with `actions-failing` so the log states
   * decisively whether the machinery is broken (events not arriving) or the
   * failure is at the page/selector layer (events arrive, page won't react).
   */
  async probeInput(): Promise<boolean> {
    try {
      await this.liveContents().executeJavaScript(
        `(() => {
          window.__epoInputProbe = false;
          document.addEventListener(
            'mousemove',
            () => { window.__epoInputProbe = true; },
            { once: true, capture: true },
          );
          return true;
        })()`,
        true,
      );
      this.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const got = await this.liveContents().executeJavaScript(
          'window.__epoInputProbe === true',
          true,
        );
        if (got === true) return true;
      }
      return false;
    } catch (e) {
      logger.warn('tab.probeInput failed', { error: String(e) });
      return false;
    }
  }

  /**
   * Diagnostic: the tab-health canary. Runs a trivial evaluate round-trip, then
   * counts requestAnimationFrame ticks over a short observation window — a live,
   * unthrottled renderer (backgroundThrottling is off) ticks many frames; a dead
   * or wedged one ticks zero. No Instagram literals involved: this probes the
   * RENDERER, not the page's DOM. Never throws — every failure mode resolves
   * `healthy: false` so callers route to tab recovery instead of crashing.
   */
  async checkHealth(
    windowMs = RECOVERY.CANARY_WINDOW_MS,
  ): Promise<{ healthy: boolean; evaluateOk: boolean; rafTicks: number }> {
    try {
      const echo = await this.evaluate<number>('1 + 1');
      if (echo !== 2) return { healthy: false, evaluateOk: false, rafTicks: 0 };
      // The rAF canary self-resolves: after `windowMs` of frames it reports the
      // tick count; a backstop timeout resolves with whatever ticked (possibly
      // zero) so a fully-stalled rAF never rides out the evaluate deadline.
      const ticks = await this.evaluate<number>(
        `(() => new Promise((resolve) => {
          let ticks = 0;
          const start = Date.now();
          const step = () => {
            ticks += 1;
            if (Date.now() - start >= ${windowMs}) resolve(ticks);
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          setTimeout(() => resolve(ticks), ${windowMs * 4});
        }))()`,
      );
      const rafTicks = typeof ticks === 'number' ? ticks : 0;
      return { healthy: rafTicks > 0, evaluateOk: true, rafTicks };
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

  /**
   * Recover a wedged tab: drop the CDP session, reload the page, and re-attach
   * the debugger (Network domain + focus emulation) so network observation and
   * input dispatch come back on the fresh renderer. Called by the main-process
   * step watchdog after it detects a stalled run. Every wait inside is
   * deadline-bounded, so recovery itself can never hang.
   */
  async recoverTab(): Promise<void> {
    const wc = this.liveContents();
    logger.warn('tab.recoverTab: reloading webContents and re-attaching debugger');
    this.pending.clear();
    const dbg = wc.debugger;
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
      logger.warn('tab.recoverTab: reload did not settle in time; re-attaching anyway', {
        timeoutMs: this.timeouts.gotoMs,
      });
    }
    this.attachDebugger();
  }

  /** Detach the debugger and release the network observer. Idempotent. */
  dispose(): void {
    this.responseHandlers.clear();
    this.pending.clear();
    const dbg = this.view.webContents.debugger;
    if (this.debuggerReady && dbg.isAttached()) {
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
    const dbg = this.view.webContents.debugger;
    if (dbg.isAttached()) {
      this.debuggerReady = true;
      return;
    }
    try {
      dbg.attach('1.3');
    } catch (e) {
      // Loud, never silent: without CDP the Reader has no data source.
      logger.error('tab.debugger.attach failed', { error: String(e) });
      return;
    }
    dbg.on('message', this.onDebuggerMessage);
    dbg
      .sendCommand('Network.enable')
      .then(() => {
        this.debuggerReady = true;
        logger.debug('tab.debugger attached; Network domain enabled');
      })
      .catch((e: unknown) => {
        logger.error('tab.Network.enable failed', { error: String(e) });
      });
    // The page always believes it is focused (Playwright's default): an
    // unfocused window otherwise fires window blur handlers that some SPAs
    // use to pause work. Best-effort — input and reads work without it.
    dbg
      .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      .catch((e: unknown) => {
        logger.warn('tab.focus-state enable failed', { error: String(e) });
      });
  }

  private readonly onDebuggerMessage = (
    _event: ElectronEvent,
    method: string,
    params: unknown,
  ): void => {
    if (method === 'Network.responseReceived') {
      const p = params as {
        requestId: string;
        response: { url: string; status: number; mimeType: string };
      };
      this.pending.set(p.requestId, {
        url: p.response.url,
        status: p.response.status,
        mimeType: p.response.mimeType,
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
    }
  };

  private emitResponse(requestId: string, meta: PendingResponse): void {
    if (this.responseHandlers.size === 0) return;
    const dbg = this.view.webContents.debugger;
    const response: TabResponse = {
      requestId,
      url: meta.url,
      status: meta.status,
      mimeType: meta.mimeType,
      getBody: async () => {
        // Deadline-bounded: a CDP call against a wedged debugger session can
        // stay pending forever — surface that as `TabUnresponsiveError`.
        const res = await withTimeout(
          dbg.sendCommand('Network.getResponseBody', { requestId }) as Promise<{
            body: string;
            base64Encoded: boolean;
          }>,
          this.timeouts.getBodyMs,
        );
        if (res === TIMED_OUT) {
          throw new TabUnresponsiveError('getBody', this.timeouts.getBodyMs);
        }
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
