/**
 * The activity veil — a `WebContentsView` layered above the embedded Instagram
 * tab. While the engine runs it is visible (a dim frosted overlay + passing shine
 * + "Working" chip) AND, because a visible native view intercepts all
 * pointer events, it blocks interaction with the tab beneath. When the engine is
 * not running it hides, releasing both the visuals and the event block.
 *
 * The show/hide is driven by engine state (see `main.ts`), with a short fade both
 * ways: activating shows immediately then animates in; deactivating animates out
 * then hides once the fade completes.
 */

import { WebContentsView, type BaseWindow, type Rectangle } from 'electron';
import * as path from 'node:path';
import type { ActivityInfo } from '@/adapter/activity-reporter';
import * as logger from '@/utils/logger';

/** Must match the veil page's opacity transition (`veil.html`). */
const FADE_MS = 400;

/** Cursor pushes are coalesced to ~one frame; the page interpolates between them. */
const CURSOR_FLUSH_MS = 16;

export class OverlayVeil {
  private readonly view: WebContentsView;
  private active = false;
  /** True while the Graph stage covers the tab region (veil must not paint). */
  private obscured = false;
  private ready = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest simulated cursor position not yet pushed to the page. */
  private pendingCursor: { x: number; y: number } | null = null;
  private cursorFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last activity pushed (dedupe key), so identical re-reports are dropped. */
  private lastActivity: string | null = null;

  constructor() {
    this.view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Transparent layer: the tab shows through, dimmed by the veil's own gradient.
    this.view.setBackgroundColor('#00000000');
    this.view.setVisible(false);
    this.view.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.active) this.apply();
    });
    void this.view.webContents.loadFile(path.join(__dirname, 'overlay', 'veil.html'));
  }

  /** Add on top of the Instagram tab (attach the tab first, then the veil). */
  attach(win: BaseWindow): void {
    win.contentView.addChildView(this.view);
  }

  setBounds(bounds: Rectangle): void {
    this.view.setBounds(bounds);
  }

  /** Show the veil (blocks interaction) while running; lift it otherwise. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.apply();
  }

  /**
   * While the Graph stage covers the tab region the veil sits ABOVE the
   * stage in native z-order, so an active run would paint the frosted overlay
   * over the graph. Obscuring force-hides the view regardless of activity;
   * un-obscuring restores whatever the activity state wants (instantly, no
   * fade — the stage swap itself is the transition).
   */
  setObscured(obscured: boolean): void {
    if (obscured === this.obscured) return;
    this.obscured = obscured;
    if (obscured) {
      if (this.hideTimer) {
        clearTimeout(this.hideTimer);
        this.hideTimer = null;
      }
      this.view.setVisible(false);
    } else if (this.active) {
      this.view.setVisible(true);
      this.run('window.__veil && window.__veil(true)');
    }
  }

  /**
   * Live "what is it doing right now" readout on the veil chip. `null` clears
   * back to the idle wording. Pushed from the ActivityReporter tap wired in the
   * composition root, so the chip distinguishes direct JSON-API work ("Reading
   * follower list") from real page driving ("Scrolling follower list").
   */
  setActivity(info: ActivityInfo | null): void {
    if (info === null) {
      this.lastActivity = null;
      this.run('window.__veilActivity && window.__veilActivity(null)');
      return;
    }
    // Drop redundant pushes (the same phase re-reported with nothing changed).
    const key = `${info.kind}|${info.label}|${info.count ?? ''}|${info.total ?? ''}|${info.detail ?? ''}`;
    if (key === this.lastActivity) return;
    this.lastActivity = key;
    this.run(`window.__veilActivity && window.__veilActivity(${JSON.stringify(info)})`);
  }

  private apply(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.active) {
      // Event-blocking + visible immediately — unless the graph stage has the
      // region, in which case the page state advances but the view stays hidden.
      if (!this.obscured) this.view.setVisible(true);
      this.run('window.__veil && window.__veil(true)');
    } else {
      this.run('window.__veil && window.__veil(false)');
      // Forget the simulated cursor with the run: it fades with the veil and
      // the next run's first fix snaps into place instead of gliding across.
      this.clearCursor();
      // The phase readout belongs to the run that just ended.
      this.setActivity(null);
      // stay visible through the fade-out, then hide so the tab is interactive again
      this.hideTimer = setTimeout(() => {
        this.view.setVisible(false);
        this.hideTimer = null;
      }, FADE_MS);
    }
  }

  // --- Digital cursor (the Interactor's simulated pointer) -------------------
  // Fed from the ObservedInputDriver tap in the foundation wiring. Moves are
  // coalesced to one push per frame (the page's rAF loop interpolates the
  // pixels in between); button state flushes any pending move first so a press
  // never renders at a stale position.

  /** The simulated cursor moved to viewport (x, y) — tab-relative CSS px,
   * which is exactly the veil's own coordinate space (identical bounds). */
  cursorMoved(x: number, y: number): void {
    if (!this.active) return;
    this.pendingCursor = { x: Math.round(x), y: Math.round(y) };
    if (this.cursorFlushTimer === null) {
      this.cursorFlushTimer = setTimeout(() => {
        this.cursorFlushTimer = null;
        this.flushCursor();
      }, CURSOR_FLUSH_MS);
    }
  }

  /** The simulated left button was pressed (`true`) or released (`false`). */
  cursorPressed(down: boolean): void {
    if (!this.active) return;
    this.flushCursor();
    this.run(`window.__cursorBtn && window.__cursorBtn(${down ? 'true' : 'false'})`);
  }

  private flushCursor(): void {
    const p = this.pendingCursor;
    if (p === null) return;
    this.pendingCursor = null;
    this.run(`window.__cursorTo && window.__cursorTo(${p.x}, ${p.y})`);
  }

  private clearCursor(): void {
    if (this.cursorFlushTimer !== null) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    this.pendingCursor = null;
    this.run('window.__cursorReset && window.__cursorReset()');
  }

  private run(code: string): void {
    if (!this.ready || this.view.webContents.isDestroyed()) return;
    this.view.webContents.executeJavaScript(code, true).catch((e: unknown) => {
      logger.error('veil.exec failed', { error: String(e) });
    });
  }

  dispose(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.cursorFlushTimer !== null) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }
}
