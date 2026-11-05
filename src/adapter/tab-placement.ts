import type { BaseWindow, WebContentsView } from 'electron';

/**
 * Conceal by sibling stacking, never native visibility. Electron 44 on macOS
 * keeps hidden-view timers alive yet stalls CDP mouse ACKs for >90 seconds.
 * A full-window opaque dashboard above the tab preserves the input pipeline.
 */
export class TabPlacement {
  private host: BaseWindow | null = null;
  private foregroundIndex = 0;

  constructor(private readonly view: WebContentsView) {}

  attach(host: BaseWindow): void {
    this.host = host;
    this.foregroundIndex = host.contentView.children?.length ?? 0;
    host.contentView.addChildView(this.view);
  }

  show(): void {
    if (!this.host) return;
    this.view.setVisible(true);
    this.host.contentView.addChildView(this.view, this.foregroundIndex);
  }

  hide(): void {
    if (!this.host) return;
    this.view.setVisible(true);
    this.host.contentView.addChildView(this.view, 0);
  }

  dispose(): void {
    this.host = null;
  }
}
