import type { InputDriver } from '@/interaction/input-driver';
import {
  type ElementRect,
  type Point,
  pathBetween,
  pressDurationMs,
  type Rng,
  stepDelays,
  targetPoint,
  travelDurationMs,
  uniform,
  wheelPlan,
} from '@/interaction/motion-profile';

export type { ElementRect, Point } from '@/interaction/motion-profile';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface InteractorDeps {
  driver: InputDriver;
  rng?: Rng;
  sleep?: (ms: number) => Promise<void>;
}

export class Interactor {
  private readonly driver: InputDriver;
  private readonly rng: Rng;
  private readonly sleep: (ms: number) => Promise<void>;
  private pos: Point;

  constructor(deps: InteractorDeps) {
    this.driver = deps.driver;
    this.rng = deps.rng ?? Math.random;
    this.sleep = deps.sleep ?? defaultSleep;
    this.pos = {
      x: Math.round(uniform(this.rng, 180, 720)),
      y: Math.round(uniform(this.rng, 160, 560)),
    };
  }

  position(): Point {
    return { ...this.pos };
  }

  async moveTo(x: number, y: number, targetWidthPx = 32): Promise<void> {
    const to: Point = { x, y };
    const path = pathBetween(this.pos, to, this.rng);
    const distance = Math.hypot(x - this.pos.x, y - this.pos.y);
    const totalMs = travelDurationMs(distance, targetWidthPx, this.rng);
    const delays = stepDelays(totalMs, Math.max(1, path.length - 1), this.rng);

    for (let i = 1; i < path.length; i++) {
      await this.sleep(delays[i - 1] ?? delays[delays.length - 1] ?? 8);
      this.driver.mouseMove(path[i].x, path[i].y);
    }
    this.pos = to;
  }

  async click(target: ElementRect): Promise<void> {
    const point = targetPoint(target, this.rng);
    await this.moveTo(point.x, point.y, Math.min(target.width, target.height));
    await this.sleep(Math.round(uniform(this.rng, 30, 120)));
    this.driver.mouseDown(this.pos.x, this.pos.y);
    await this.sleep(pressDurationMs(this.rng));
    this.driver.mouseUp(this.pos.x, this.pos.y);
  }

  async scroll(container: ElementRect, deltaPx: number, restPoint?: Point): Promise<void> {
    if (deltaPx === 0) return;
    if (restPoint !== undefined) {
      await this.moveTo(restPoint.x, restPoint.y, Math.min(container.width, container.height));
    } else if (!this.inside(this.pos, container)) {
      const entry = targetPoint(container, this.rng);
      await this.moveTo(entry.x, entry.y, Math.min(container.width, container.height));
    }
    for (const tick of wheelPlan(deltaPx, this.rng)) {
      this.driver.wheel(this.pos.x, this.pos.y, tick.deltaPx);
      await this.sleep(tick.pauseMs);
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
