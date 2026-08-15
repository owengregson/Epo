export type PointerInputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseUp'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number };

export interface InputEventSink {
  sendInputEvent(event: PointerInputEvent): void;
}

export interface InputDriver {
  mouseMove(x: number, y: number): void;
  mouseDown(x: number, y: number): void;
  mouseUp(x: number, y: number): void;
  wheel(x: number, y: number, deltaYPx: number): void;
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

  mouseMove(x: number, y: number): void {
    this.inner.mouseMove(x, y);
    this.observer.moved(x, y);
  }

  mouseDown(x: number, y: number): void {
    this.inner.mouseDown(x, y);
    this.observer.moved(x, y);
    this.observer.pressed(true);
  }

  mouseUp(x: number, y: number): void {
    this.inner.mouseUp(x, y);
    this.observer.moved(x, y);
    this.observer.pressed(false);
  }

  wheel(x: number, y: number, deltaYPx: number): void {
    this.inner.wheel(x, y, deltaYPx);
    this.observer.moved(x, y);
  }
}

export class ElectronInputDriver implements InputDriver {
  constructor(private readonly sink: InputEventSink) {}

  mouseMove(x: number, y: number): void {
    this.sink.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  }

  mouseDown(x: number, y: number): void {
    this.sink.sendInputEvent({
      type: 'mouseDown',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
  }

  mouseUp(x: number, y: number): void {
    this.sink.sendInputEvent({
      type: 'mouseUp',
      x: Math.round(x),
      y: Math.round(y),
      button: 'left',
      clickCount: 1,
    });
  }

  wheel(x: number, y: number, deltaYPx: number): void {
    this.sink.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: 0,
      deltaY: -Math.round(deltaYPx),
    });
  }
}
