/**
 * Humanizer facade: event sequences through a recording InputDriver, with an
 * injected rng + sleep recorder (no real timers, fully deterministic).
 */
import { Humanizer } from '@/humanizer/humanizer';
import {
  ElectronInputDriver,
  type HumanInputEvent,
  type InputDriver,
} from '@/humanizer/input-driver';
import { HOLD_MAX_MS, HOLD_MIN_MS, type ElementRect } from '@/humanizer/motion-profile';

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Recorded =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down'; x: number; y: number }
  | { kind: 'up'; x: number; y: number }
  | { kind: 'wheel'; x: number; y: number; deltaY: number };

/** Records every driver call in order. */
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

const build = (seed: number): { h: Humanizer; driver: RecordingDriver; sleeps: number[] } => {
  const driver = new RecordingDriver();
  const sleeps: number[] = [];
  const h = new Humanizer({
    driver,
    rng: mulberry32(seed),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { h, driver, sleeps };
};

const inside = (p: { x: number; y: number }, r: ElementRect): boolean =>
  p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;

const TARGET: ElementRect = { x: 500, y: 300, width: 140, height: 44 };

describe('Humanizer.click', () => {
  test('emits moves, then down → hold → up at ONE interior point of the hitbox', async () => {
    for (let seed = 1; seed < 15; seed++) {
      const { h, driver, sleeps } = build(seed);
      await h.click(TARGET);

      const kinds = driver.events.map((e) => e.kind);
      const downAt = kinds.indexOf('down');
      const upAt = kinds.indexOf('up');
      expect(downAt).toBeGreaterThan(0); // moves precede the press
      expect(upAt).toBe(downAt + 1); // nothing between press and release
      for (let i = 0; i < downAt; i++) expect(kinds[i]).toBe('move');

      const down = driver.events[downAt] as Extract<Recorded, { kind: 'down' }>;
      const up = driver.events[upAt] as Extract<Recorded, { kind: 'up' }>;
      expect(up.x).toBe(down.x); // release where pressed
      expect(up.y).toBe(down.y);
      expect(inside(down, TARGET)).toBe(true); // interior, not edge

      // The last move landed exactly where the press happened.
      const lastMove = driver.events[downAt - 1] as Extract<Recorded, { kind: 'move' }>;
      expect(lastMove.x).toBe(down.x);
      expect(lastMove.y).toBe(down.y);

      // The hold (the sleep between down and up) is inside the 40–120 ms band.
      const hold = sleeps[sleeps.length - 1];
      expect(hold).toBeGreaterThanOrEqual(HOLD_MIN_MS);
      expect(hold).toBeLessThanOrEqual(HOLD_MAX_MS);
    }
  });

  test('successive clicks chain from the previous position (a real hand does not teleport)', async () => {
    const { h, driver } = build(21);
    await h.click(TARGET);
    const firstUp = driver.events.filter((e) => e.kind === 'up')[0];
    driver.events = [];

    const second: ElementRect = { x: 60, y: 600, width: 90, height: 30 };
    await h.click(second);
    const firstMove = driver.events[0] as Extract<Recorded, { kind: 'move' }>;
    // The second path's first emitted step starts NEAR the previous click point
    // (one step along the travel), far from the second target.
    const stepFromOldPos = Math.hypot(firstMove.x - firstUp.x, firstMove.y - firstUp.y);
    const centerOfSecond = { x: second.x + second.width / 2, y: second.y + second.height / 2 };
    const travel = Math.hypot(firstUp.x - centerOfSecond.x, firstUp.y - centerOfSecond.y);
    expect(stepFromOldPos).toBeLessThan(travel / 2);
  });
});

describe('Humanizer.moveTo', () => {
  test('emits intermediate moves ending exactly at the destination and updates position', async () => {
    const { h, driver } = build(31);
    await h.moveTo(800, 500);
    const moves = driver.events.filter((e) => e.kind === 'move');
    expect(moves.length).toBeGreaterThanOrEqual(3); // intermediate points, not a jump
    const last = moves[moves.length - 1];
    expect(last.x).toBe(800);
    expect(last.y).toBe(500);
    expect(h.position()).toEqual({ x: 800, y: 500 });
  });

  test('every step is preceded by a positive pause (no zero-delay machine-gun moves)', async () => {
    const { h, driver, sleeps } = build(32);
    await h.moveTo(700, 200);
    const moves = driver.events.filter((e) => e.kind === 'move').length;
    expect(sleeps.length).toBeGreaterThanOrEqual(moves);
    for (const ms of sleeps) expect(ms).toBeGreaterThan(0);
  });
});

describe('Humanizer.scroll', () => {
  // Placed right of the Humanizer's whole idle-start zone (x ≤ 720), so the
  // cursor always begins OUTSIDE and the enter-the-container move is exercised.
  const CONTAINER: ElementRect = { x: 800, y: 120, width: 400, height: 500 };

  test('enters the container first, then wheels a burst summing ≈ the request', async () => {
    const { h, driver } = build(41);
    await h.scroll(CONTAINER, 1600);

    const wheels = driver.events.filter((e) => e.kind === 'wheel');
    expect(wheels.length).toBeGreaterThan(3); // a burst of notches, not one jump
    // Every wheel fired with the cursor inside the container.
    for (const w of wheels) expect(inside(w, CONTAINER)).toBe(true);
    // The first wheel comes only after the cursor moved into the container.
    const firstWheelAt = driver.events.findIndex((e) => e.kind === 'wheel');
    const movesBefore = driver.events.slice(0, firstWheelAt).filter((e) => e.kind === 'move');
    expect(movesBefore.length).toBeGreaterThan(0);
    expect(inside(movesBefore[movesBefore.length - 1], CONTAINER)).toBe(true);
    // Total distance ≈ requested (96–105 % band from the motion profile).
    const sum = wheels.reduce((a, w) => a + w.deltaY, 0);
    expect(sum).toBeGreaterThanOrEqual(1600 * 0.96 - 1);
    expect(sum).toBeLessThanOrEqual(1600 * 1.05 + 1);
  });

  test('individual notches are human-sized (no single full-distance mega-tick)', async () => {
    const { h, driver } = build(42);
    await h.scroll(CONTAINER, 2000);
    const wheels = driver.events.filter((e) => e.kind === 'wheel');
    for (const w of wheels) expect(Math.abs(w.deltaY)).toBeLessThan(400);
  });

  test('a zero delta is a no-op', async () => {
    const { h, driver } = build(43);
    await h.scroll(CONTAINER, 0);
    expect(driver.events).toEqual([]);
  });
});

describe('ElectronInputDriver', () => {
  test('maps port calls onto trusted sendInputEvent payloads (wheel sign inverted)', () => {
    const sent: HumanInputEvent[] = [];
    const driver = new ElectronInputDriver({ sendInputEvent: (e) => sent.push(e) });

    driver.mouseMove(10.6, 20.2);
    driver.mouseDown(10, 20);
    driver.mouseUp(10, 20);
    driver.wheel(10, 20, 120); // DOM +120 (content down) → Electron deltaY -120

    expect(sent).toEqual([
      { type: 'mouseMove', x: 11, y: 20 },
      { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 },
      { type: 'mouseUp', x: 10, y: 20, button: 'left', clickCount: 1 },
      { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: -120 },
    ]);
  });
});
