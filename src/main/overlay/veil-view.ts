/**
 * The automation veil — a `WebContentsView` layered above the embedded Instagram
 * tab. While the engine runs it is visible (a dim frosted overlay + passing shine
 * + "Automation active" chip) AND, because a visible native view intercepts all
 * pointer events, it blocks interaction with the tab beneath. When the engine is
 * not running it hides, releasing both the visuals and the event block.
 *
 * The show/hide is driven by engine state (see `main.ts`), with a short fade both
 * ways: activating shows immediately then animates in; deactivating animates out
 * then hides once the fade completes.
 */

import { WebContentsView, type BaseWindow, type Rectangle } from 'electron';
import * as path from 'path';
import * as logger from '@/utils/logger';

/** Must match the veil page's opacity transition (`veil.html`). */
const FADE_MS = 400;

export class OverlayVeil {
  private readonly view: WebContentsView;
  private active = false;
  private ready = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

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

  private apply(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.active) {
      this.view.setVisible(true); // event-blocking + visible immediately
      this.run('window.__veil && window.__veil(true)');
    } else {
      this.run('window.__veil && window.__veil(false)');
      // stay visible through the fade-out, then hide so the tab is interactive again
      this.hideTimer = setTimeout(() => {
        this.view.setVisible(false);
        this.hideTimer = null;
      }, FADE_MS);
    }
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
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close();
    }
  }
}
