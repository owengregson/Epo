/**
 * Humanizer — the facade that makes every synthetic input to the Instagram
 * page read like a real person at a real mouse.
 *
 * It drives an injected {@link InputDriver} (real trusted events via
 * `webContents.sendInputEvent` in production, a recording fake in tests) using
 * the pure motion math in `motion-profile.ts`:
 *
 *  - `moveTo`   — Bezier-arc cursor travel with Fitts-scaled, bell-shaped
 *                 per-step timing (and occasional overshoot-and-settle).
 *  - `click`    — move onto a gaussian-sampled point INSIDE the hitbox, a
 *                 short aim-settle beat, then mouseDown → 40–120 ms hold →
 *                 mouseUp at the same point.
 *  - `scroll`   — enter the container if the cursor is outside it, then a
 *                 wheel-tick burst with human cadence (ramp/decay, micro-
 *                 pauses, slight over-scroll + correction).
 *
 * The Humanizer tracks its own virtual cursor position between calls so
 * successive gestures chain from wherever the "hand" last was.
 *
 * Timing note (timing-branch coordination): the local `sleep` below is an
 * intra-gesture micro-delay, deliberately self-contained — the later timing
 * unification can swap it for the shared primitive in one place.
 */

import type { InputDriver } from '@/humanizer/input-driver';
import {
  clickPoint,
  cursorPath,
  fittsDurationMs,
  holdDurationMs,
  scrollPlan,
  stepDelays,
  uniform,
  type ElementRect,
  type Point,
  type Rng,
} from '@/humanizer/motion-profile';

export type { ElementRect, Point } from '@/humanizer/motion-profile';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface HumanizerDeps {
  driver: InputDriver;
  /** Injectable randomness (deterministic tests). Defaults to Math.random. */
  rng?: Rng;
  /** Injectable pause; defaults to a real setTimeout (tests record the ms). */
  sleep?: (ms: number) => Promise<void>;
}

export class Humanizer {
  private readonly driver: InputDriver;
  private readonly rng: Rng;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The virtual cursor's last known position; gestures chain from here. */
  private pos: Point;

  constructor(deps: HumanizerDeps) {
    this.driver = deps.driver;
    this.rng = deps.rng ?? Math.random;
    this.sleep = deps.sleep ?? defaultSleep;
    // Start somewhere plausible: an idle cursor rests in the content area, not
    // at (0,0) — a top-left origin on the first move is a synthetic tell.
    this.pos = {
      x: Math.round(uniform(this.rng, 180, 720)),
      y: Math.round(uniform(this.rng, 160, 560)),
    };
  }

  /** Where the virtual cursor currently rests (tests / diagnostics). */
  position(): Point {
    return { ...this.pos };
  }

  /**
   * Travel to (x, y) along a human path: intermediate trusted mouseMove events
   * spaced by a Fitts-scaled, bell-shaped delay profile. `targetWidthPx` (the
   * effective target size) sharpens or relaxes the duration model; defaults to
   * a typical control height.
   */
  async moveTo(x: number, y: number, targetWidthPx = 32): Promise<void> {
    const to: Point = { x, y };
    const path = cursorPath(this.pos, to, this.rng);
    const distance = Math.hypot(x - this.pos.x, y - this.pos.y);
    const totalMs = fittsDurationMs(distance, targetWidthPx, this.rng);
    const delays = stepDelays(totalMs, Math.max(1, path.length - 1), this.rng);

    // path[0] is the current position — no event for standing still.
    for (let i = 1; i < path.length; i++) {
      await this.sleep(delays[i - 1] ?? delays[delays.length - 1] ?? 8);
      this.driver.mouseMove(path[i].x, path[i].y);
    }
    this.pos = to;
  }

  /**
   * Click a target hitbox: aim at a gaussian-sampled interior point (never the
   * exact center or an edge), travel there, settle 30–120 ms (the micro-beat
   * between arriving on a control and pressing — motor studies call it the
   * verification pause), then press-hold-release with a 40–120 ms hold.
   */
  async click(target: ElementRect): Promise<void> {
    const point = clickPoint(target, this.rng);
    await this.moveTo(point.x, point.y, Math.min(target.width, target.height));
    // Aim-settle beat: 30–120 ms between arrival and press.
    await this.sleep(Math.round(uniform(this.rng, 30, 120)));
    this.driver.mouseDown(this.pos.x, this.pos.y);
    await this.sleep(holdDurationMs(this.rng));
    this.driver.mouseUp(this.pos.x, this.pos.y);
  }

  /**
   * Scroll a container by ≈ `deltaPx` (DOM sign: positive = content down).
   * If the cursor is outside the container it first travels to a sampled
   * interior point (wheel events only reach the scroller under the cursor),
   * then emits the motion profile's wheel-tick plan with its human cadence.
   * The distance actually covered is randomized around the request — callers
   * re-measure and iterate rather than trusting pixel exactness.
   */
  async scroll(container: ElementRect, deltaPx: number): Promise<void> {
    if (deltaPx === 0) return;
    if (!this.inside(this.pos, container)) {
      const entry = clickPoint(container, this.rng);
      await this.moveTo(entry.x, entry.y, Math.min(container.width, container.height));
    }
    for (const tick of scrollPlan(deltaPx, this.rng)) {
      this.driver.wheel(this.pos.x, this.pos.y, tick.deltaPx);
      await this.sleep(tick.pauseMs);
      // Idle drift: ~15 % of notches come with a 1–3 px hand-rest wobble —
      // a cursor frozen to the pixel through a long scroll is a robot tell.
      if (this.rng() < 0.15) {
        const drifted: Point = {
          x: this.pos.x + Math.round(uniform(this.rng, -3, 3)),
          y: this.pos.y + Math.round(uniform(this.rng, -3, 3)),
        };
        if (this.inside(drifted, container)) {
          this.pos = drifted;
          this.driver.mouseMove(drifted.x, drifted.y);
        }
      }
    }
  }

  private inside(p: Point, rect: ElementRect): boolean {
    return (
      p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height
    );
  }
}
