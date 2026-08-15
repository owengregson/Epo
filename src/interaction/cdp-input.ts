/**
 * Electron-shaped pointer events → CDP `Input.dispatchMouseEvent` params.
 *
 * Why CDP instead of `webContents.sendInputEvent`: Electron documents that
 * `sendInputEvent` only works while the host window is FOCUSED. Epo's whole
 * point is unattended overnight runs with the window in the background — under
 * `sendInputEvent` every click of such a run is silently dropped (the Actor
 * logs `clicked: true`, the page never sees a thing). CDP input injection goes
 * through the browser's real input pipeline (same mechanism Puppeteer and
 * Playwright use), produces `isTrusted` events, and works regardless of window
 * focus, occlusion, or the veil overlay stacked above the tab.
 *
 * Coordinate space: CDP takes CSS pixels relative to the target webContents'
 * viewport — exactly what the surface locate scripts' `getBoundingClientRect`
 * rects are in, so no offset math is needed.
 *
 * Wheel direction: the `PointerInputEvent` seam carries ELECTRON semantics
 * (positive `deltaY` = wheel up), which `ElectronInputDriver` produces by
 * negating its scroll-down distances. CDP wants DOM `WheelEvent` semantics
 * (positive `deltaY` = scroll down), so the conversion negates back.
 */

import type { PointerInputEvent } from '@/interaction/input-driver';

/** The exact param shape `Input.dispatchMouseEvent` accepts (subset we use). */
export interface CdpMouseEventParams {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
  x: number;
  y: number;
  button?: 'none' | 'left';
  /** Bitfield of buttons held DURING the event (1 = left). */
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

export function toCdpMouseParams(event: PointerInputEvent): CdpMouseEventParams {
  switch (event.type) {
    case 'mouseMove':
      return { type: 'mouseMoved', x: event.x, y: event.y, button: 'none', buttons: 0 };
    case 'mouseDown':
      return {
        type: 'mousePressed',
        x: event.x,
        y: event.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      };
    case 'mouseUp':
      // `buttons` reflects the held set AFTER release (Puppeteer's convention);
      // `button`+`clickCount` are what Chromium uses to synthesize the `click`.
      return {
        type: 'mouseReleased',
        x: event.x,
        y: event.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      };
    case 'mouseWheel':
      return {
        type: 'mouseWheel',
        x: event.x,
        y: event.y,
        button: 'none',
        buttons: 0,
        // `|| 0` normalizes the negation's `-0` back to plain `0`.
        deltaX: -event.deltaX || 0,
        deltaY: -event.deltaY || 0,
      };
  }
}
