import * as logger from '@/utils/logger';

export type PointerInputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseUp'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number };

export interface InputEventSink {
  sendInputEvent(event: PointerInputEvent): void | Promise<void>;
}

export interface InputDriver {
  mouseMove(x: number, y: number): void | Promise<void>;
  mouseDown(x: number, y: number): void | Promise<void>;
  mouseUp(x: number, y: number): void | Promise<void>;
  wheel(x: number, y: number, deltaYPx: number): void | Promise<void>;
}

export interface CursorObserver {
  moved(x: number, y: number): void;
  pressed(down: boolean): void;
}

export class ObservedInputDriver implements InputDriver {
  constructor(
    private readonly inner: InputDriver,
    private readonly observer: CursorObserver,
  ) {}

  async mouseMove(x: number, y: number): Promise<void> {
    await this.inner.mouseMove(x, y);
    this.observe(() => this.observer.moved(x, y));
  }

  async mouseDown(x: number, y: number): Promise<void> {
    await this.inner.mouseDown(x, y);
    this.observe(() => { this.observer.moved(x, y); this.observer.pressed(true); });
  }

  async mouseUp(x: number, y: number): Promise<void> {
    await this.inner.mouseUp(x, y);
    this.observe(() => { this.observer.moved(x, y); this.observer.pressed(false); });
  }

  async wheel(x: number, y: number, deltaYPx: number): Promise<void> {
    await this.inner.wheel(x, y, deltaYPx);
    this.observe(() => this.observer.moved(x, y));
  }

  private observe(update: () => void): void {
    try { update(); } catch (error) {
      logger.warn('cursor observer failed after accepted input', { error: String(error) });
    }
  }
}

export class ElectronInputDriver implements InputDriver {
  constructor(private readonly sink: InputEventSink) {}

  mouseMove(x: number, y: number): void | Promise<void> {
    return this.sink.sendInputEvent({ type: 'mouseMove', x, y });
  }

  mouseDown(x: number, y: number): void | Promise<void> {
    return this.sink.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  mouseUp(x: number, y: number): void | Promise<void> {
    return this.sink.sendInputEvent({
      type: 'mouseUp',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  wheel(x: number, y: number, deltaYPx: number): void | Promise<void> {
    return this.sink.sendInputEvent({
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: -Math.round(deltaYPx),
    });
  }
}
