import { ActionAbortedError, AdapterStaleError, TabUnresponsiveError } from '@/adapter/errors';
import type { InputDriver } from '@/interaction/input-driver';
import {
  containPoint,
  type ElementRect,
  intersectRect,
  movementPlan,
  type Point,
  pressDurationMs,
  type Rng,
  targetPoint,
  uniform,
  wheelPlan,
} from '@/interaction/motion-profile';
import { MOTION } from '@/kernel/motion-policy';
import { sleep as defaultSleep, type SleepFn } from '@/timing/primitives';

export type { ElementRect, Point } from '@/interaction/motion-profile';

export interface ClickGuard {
  validate(): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface InteractorDeps {
  driver: InputDriver;
  rng?: Rng;
  sleep?: SleepFn;
  abortSignal?: () => AbortSignal | undefined;
  contextVersion?: () => unknown;
  canClick?: (target: ElementRect, point: Point) => Promise<boolean>;
  prepareClick?: (target: ElementRect, point: Point) => Promise<ClickGuard>;
  viewport?: () => Promise<ElementRect>;
}

export class Interactor {
  private readonly driver: InputDriver;
  private readonly rng: Rng;
  private readonly sleep: SleepFn;
  private tail: Promise<void> = Promise.resolve();
  private pos: Point;
  private boundedStart = false;

  constructor(private readonly deps: InteractorDeps) {
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
    return this.gesture(async (guard, signal) => {
      const bounds = await this.viewport(guard);
      await this.move(x, y, targetWidthPx, guard, signal, bounds);
    });
  }

  private async move(x: number, y: number, targetWidthPx: number, guard: () => void, signal?: AbortSignal, bounds?: ElementRect): Promise<void> {
    const to: Point = { x, y };
    const { points: path, delaysMs: delays } = movementPlan(this.pos, to, targetWidthPx, this.rng, { bounds });

    for (let i = 1; i < path.length; i++) {
      await this.sleep(delays[i - 1], signal);
      guard();
      await this.driver.mouseMove(path[i].x, path[i].y);
      this.pos = { ...path[i] };
    }
    this.pos = to;
  }

  /**
   * Rest the cursor on `target` and let the page react — no press. Instagram
   * re-renders some controls as the cursor arrives (the nav rail) or restyles
   * them on hover (drawer controls), so a press planned on the rect located
   * BEFORE travel targets a node that is gone; the caller locates the control
   * again after this resolves and presses what is there now.
   */
  async hover(target: ElementRect): Promise<void> {
    return this.gesture(async (guard, signal) => {
      const bounds = await this.viewport(guard);
      const visible = bounds ? intersectRect(target, bounds) : target;
      if (!visible) throw new RangeError('Hover target is outside the viewport');
      const point = targetPoint(visible, this.rng, bounds);
      await this.move(point.x, point.y, Math.min(visible.width, visible.height), guard, signal, bounds);
      await this.sleep(Math.round(uniform(this.rng, MOTION.hoverSettleMs[0], MOTION.hoverSettleMs[1])), signal);
      guard();
    });
  }

  async click(target: ElementRect): Promise<void> {
    return this.gesture(async (guard, signal) => {
      const bounds = await this.viewport(guard);
      const point = targetPoint(target, this.rng, bounds);
      const visible = bounds ? intersectRect(target, bounds) : target;
      if (!visible) throw new RangeError('Click target is outside the viewport');
      const clickGuard = await this.deps.prepareClick?.(target, point);
      try {
        await this.move(point.x, point.y, Math.min(visible.width, visible.height), guard, signal, bounds);
        await this.sleep(Math.round(uniform(this.rng, 30, 120)), signal);
        guard();
        if ((clickGuard && !(await clickGuard.validate()))
          || (this.deps.canClick && !(await this.deps.canClick(target, point)))) {
          throw new AdapterStaleError('input.click', 'control moved, disabled or covered');
        }
        guard();
        const version = this.deps.contextVersion?.();
        let accepted = false;
        let failure: { error: unknown } | null = null;
        try {
          await this.driver.mouseDown(this.pos.x, this.pos.y);
          accepted = true;
          // Finish an accepted press even if Pause arrives during the short hold.
          await this.sleep(pressDurationMs(this.rng), signal);
        } catch (error) {
          failure = { error };
        }
        if (version === this.deps.contextVersion?.()) {
          try { await this.driver.mouseUp(this.pos.x, this.pos.y); }
          catch (error) { failure ??= { error }; }
        } else if (accepted) {
          failure = { error: new TabUnresponsiveError('input:document-changed-during-press', 0, 'post-click') };
        }
        if (failure) throw failure.error;
      } finally {
        await clickGuard?.dispose();
      }
    });
  }

  async scroll(container: ElementRect, deltaPx: number, restPoint?: Point): Promise<void> {
    return this.gesture((guard, signal) => this.scrollWithin(container, deltaPx, guard, signal, restPoint));
  }

  private async scrollWithin(container: ElementRect, deltaPx: number, guard: () => void, signal?: AbortSignal, restPoint?: Point): Promise<void> {
    if (deltaPx === 0) return;
    const ticks = wheelPlan(deltaPx, this.rng);
    const bounds = await this.viewport(guard);
    const visible = bounds ? intersectRect(container, bounds) : container;
    if (!visible) throw new RangeError('Scroll container is outside the viewport');
    container = visible;
    if (restPoint !== undefined) {
      if (!this.inside(restPoint, container)) throw new RangeError('Scroll rest point is outside its container');
      await this.move(restPoint.x, restPoint.y, Math.min(container.width, container.height), guard, signal, bounds);
    } else if (!this.inside(this.pos, container)) {
      const entry = targetPoint(container, this.rng);
      await this.move(entry.x, entry.y, Math.min(container.width, container.height), guard, signal, bounds);
    }
    for (const tick of ticks) {
      guard();
      await this.driver.wheel(this.pos.x, this.pos.y, tick.deltaPx);
      await this.sleep(tick.pauseMs, signal);
      guard();
      if (restPoint === undefined && this.rng() < 0.15) {
        const drifted: Point = {
          x: this.pos.x + Math.round(uniform(this.rng, -3, 3)),
          y: this.pos.y + Math.round(uniform(this.rng, -3, 3)),
        };
        if (this.inside(drifted, container)) {
          await this.driver.mouseMove(drifted.x, drifted.y);
          this.pos = drifted;
        }
      }
    }
  }

  private async viewport(guard: () => void): Promise<ElementRect | undefined> {
    const bounds = await this.deps.viewport?.();
    guard();
    this.pos = bounds && !this.boundedStart ? targetPoint(bounds, this.rng) : containPoint(this.pos, bounds);
    if (bounds) this.boundedStart = true;
    return bounds;
  }

  private gesture(run: (guard: () => void, signal?: AbortSignal) => Promise<void>): Promise<void> {
    const signal = this.deps.abortSignal?.();
    const version = this.deps.contextVersion?.();
    const guard = (): void => {
      if (signal?.aborted || version !== this.deps.contextVersion?.()) {
        throw new ActionAbortedError('input.gesture');
      }
    };
    const operation = this.tail.then(async () => {
      guard();
      await run(guard, signal);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  private inside(p: Point, rect: ElementRect): boolean {
    return (
      p.x > rect.x && p.x < rect.x + rect.width && p.y > rect.y && p.y < rect.y + rect.height
    );
  }
}
