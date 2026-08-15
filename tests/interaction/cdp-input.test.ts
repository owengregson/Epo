import { toCdpMouseParams } from '@/interaction/cdp-input';

// The tab dispatches input via CDP `Input.dispatchMouseEvent` (focus-independent,
// unlike `webContents.sendInputEvent`, which drops everything while the window is
// unfocused — the overnight-run failure). These pin the exact param mapping.

test('mouseMove → mouseMoved with no buttons held', () => {
  expect(toCdpMouseParams({ type: 'mouseMove', x: 10, y: 20 })).toEqual({
    type: 'mouseMoved',
    x: 10,
    y: 20,
    button: 'none',
    buttons: 0,
  });
});

test('mouseDown/mouseUp → pressed/released with left button + clickCount (click synthesis)', () => {
  expect(
    toCdpMouseParams({ type: 'mouseDown', x: 5, y: 6, button: 'left', clickCount: 1 }),
  ).toEqual({ type: 'mousePressed', x: 5, y: 6, button: 'left', buttons: 1, clickCount: 1 });
  expect(
    toCdpMouseParams({ type: 'mouseUp', x: 5, y: 6, button: 'left', clickCount: 1 }),
  ).toEqual({ type: 'mouseReleased', x: 5, y: 6, button: 'left', buttons: 0, clickCount: 1 });
});

test('mouseWheel negates back to DOM semantics (Electron wheel-up-positive → CDP down-positive)', () => {
  // ElectronInputDriver encodes "scroll down 120px" as deltaY: -120 (Electron
  // wheel semantics). CDP wants DOM WheelEvent semantics: positive = down.
  expect(
    toCdpMouseParams({ type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: -120 }),
  ).toEqual({
    type: 'mouseWheel',
    x: 1,
    y: 2,
    button: 'none',
    buttons: 0,
    deltaX: 0,
    deltaY: 120,
  });
});
