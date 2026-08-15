/**
 * ObservedInputDriver: forwards every event to the wrapped driver unchanged
 * while reporting cursor position/button state to the observer — the tap the
 * overlay veil's digital cursor rides on.
 */
import {
  ObservedInputDriver,
  type CursorObserver,
  type InputDriver,
} from '@/interaction/input-driver';

type Recorded =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down'; x: number; y: number }
  | { kind: 'up'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaY: number };

class RecordingDriver implements InputDriver {
  events: Recorded[] = [];
  mouseMove(x: number, y: number): void {
    this.events.push({ kind: 'move', x, y });
  }
  mouseDown(x: number, y: number): void {
    this.events.push({ kind: 'down', x, y });
  }
  mouseUp(x: number, y: number): void {
    this.events.push({ kind: 'up', x, y });
  }
  wheel(x: number, y: number, deltaY: number): void {
    this.events.push({ kind: 'wheel', x, y, deltaY });
  }
}

type Observed = { kind: 'moved'; x: number; y: number } | { kind: 'pressed'; down: boolean };

class RecordingObserver implements CursorObserver {
  events: Observed[] = [];
  moved(x: number, y: number): void {
    this.events.push({ kind: 'moved', x, y });
  }
  pressed(down: boolean): void {
    this.events.push({ kind: 'pressed', down });
  }
}

const build = (): { driver: ObservedInputDriver; inner: RecordingDriver; obs: RecordingObserver } => {
  const inner = new RecordingDriver();
  const obs = new RecordingObserver();
  return { driver: new ObservedInputDriver(inner, obs), inner, obs };
};

describe('ObservedInputDriver', () => {
  test('mouseMove forwards unchanged and reports the position', () => {
    const { driver, inner, obs } = build();
    driver.mouseMove(120, 340);
    expect(inner.events).toEqual([{ kind: 'move', x: 120, y: 340 }]);
    expect(obs.events).toEqual([{ kind: 'moved', x: 120, y: 340 }]);
  });

  test('mouseDown/mouseUp report position BEFORE button state', () => {
    const { driver, inner, obs } = build();
    driver.mouseDown(50, 60);
    driver.mouseUp(50, 60);
    expect(inner.events).toEqual([
      { kind: 'down', x: 50, y: 60 },
      { kind: 'up', x: 50, y: 60 },
    ]);
    expect(obs.events).toEqual([
      { kind: 'moved', x: 50, y: 60 },
      { kind: 'pressed', down: true },
      { kind: 'moved', x: 50, y: 60 },
      { kind: 'pressed', down: false },
    ]);
  });

  test('wheel forwards the delta and reports the resting position', () => {
    const { driver, inner, obs } = build();
    driver.wheel(400, 500, 240);
    expect(inner.events).toEqual([{ kind: 'wheel', x: 400, y: 500, deltaY: 240 }]);
    expect(obs.events).toEqual([{ kind: 'moved', x: 400, y: 500 }]);
  });

  test('observation never mutates the forwarded event stream', () => {
    const { driver, inner } = build();
    driver.mouseMove(1, 2);
    driver.mouseDown(1, 2);
    driver.wheel(1, 2, -30);
    driver.mouseUp(1, 2);
    expect(inner.events.map((e) => e.kind)).toEqual(['move', 'down', 'wheel', 'up']);
  });
});
