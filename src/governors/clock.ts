/** Injectable time source so governors are deterministically testable. */
export interface Clock {
  now(): number;
}

/** Real wall-clock. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Controllable clock for tests. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start: number) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
