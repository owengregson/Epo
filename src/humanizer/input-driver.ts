/**
 * InputDriver — the port through which the Humanizer emits input, plus the
 * Electron implementation over `webContents.sendInputEvent`.
 *
 * `sendInputEvent` synthesizes REAL trusted input events at the Chromium input
 * pipeline level (isTrusted mouse moves/downs/ups/wheels), which is the whole
 * point of the Humanizer: the page cannot distinguish them from OS input the
 * way it can an `el.click()` from injected JS. The driver is deliberately dumb
 * — one event per call, no timing, no paths — so all human-likeness lives in
 * the pure motion profile and the facade, and tests can inject a recording
 * fake here to assert exact event sequences.
 */

/** Structural subset of Electron's mouse input events (no electron import —
 * the humanizer package stays main-process-agnostic and node-testable). */
export type HumanInputEvent =
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseUp'; x: number; y: number; button: 'left'; clickCount: 1 }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number };

/**
 * Anything that can deliver a trusted input event to the page. `InstagramTab`
 * satisfies this via its additive `sendInputEvent` method (its parameter is
 * Electron's wider event union; method-parameter bivariance makes the
 * structural match work without an electron type dependency here).
 */
export interface InputEventSink {
  sendInputEvent(event: HumanInputEvent): void;
}

/** The Humanizer's input port. Coordinates are viewport CSS px (DIP). */
export interface InputDriver {
  mouseMove(x: number, y: number): void;
  /** Left-button press at (x, y). */
  mouseDown(x: number, y: number): void;
  /** Left-button release at (x, y). */
  mouseUp(x: number, y: number): void;
  /**
   * One wheel movement. `deltaYPx` uses DOM `wheel`-event semantics: POSITIVE
   * scrolls the content DOWN (toward the end of the list).
   */
  wheel(x: number, y: number, deltaYPx: number): void;
}

/**
 * The live implementation over an Electron webContents (via the tab's
 * `sendInputEvent`). Coordinates are rounded to integers — Chromium expects
 * integral DIPs and fractional coordinates are a synthetic-input tell.
 */
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
    // Electron/Chromium wheel semantics are inverted relative to DOM `wheel`
    // deltas: a NEGATIVE sendInputEvent deltaY scrolls the content DOWN (it
    // mirrors the physical wheel rotation, not the DOM delta). Negate here so
    // callers can think in DOM terms (positive = content down).
    this.sink.sendInputEvent({
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX: 0,
      deltaY: -Math.round(deltaYPx),
    });
  }
}
