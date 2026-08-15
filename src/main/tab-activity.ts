/**
 * TabActivity — the activity veil's stateful authority.
 *
 * The veil used to be inferred from renderer status projections (`running` /
 * `scanning`), which lag the actual tab traffic: a prune claims the tab and
 * navigates during the lazy graph build BEFORE its first status emit, and
 * manual one-off ops (seed check, manual read/follow) never raised it at all.
 *
 * This class is a tiny state machine over NAMED HOLDS placed at the *sources*
 * of tab work instead. The veil is active exactly while ANY hold exists:
 *
 *  - `hold`/`release`: ref-counted scoped holds for operations (an op may
 *    overlap itself, e.g. two manual actions in flight). `release` of an
 *    absent name is an idempotent no-op, so backstop releases are safe.
 *  - `signal`: level-triggered holds for STATE STREAMS (the growth engine's
 *    status projection) — `on` ensures exactly one hold, `off` clears it,
 *    repeated same-level signals never stack.
 *  - `with`: hold around an async op, released on every exit path.
 *
 * `onChange` fires on every composition change (a name appearing or
 * disappearing) with the aggregate `active` bool + the live hold names, so the
 * consumer can both drive the veil and log WHY it is up.
 */

export type ActivityChange = (active: boolean, holds: string[]) => void;

export class TabActivity {
  private readonly counts = new Map<string, number>();

  constructor(private readonly onChange?: ActivityChange) {}

  /** Whether any routine currently drives the page. */
  active(): boolean {
    return this.counts.size > 0;
  }

  /** The live hold names (diagnostics / logging). */
  holds(): string[] {
    return [...this.counts.keys()];
  }

  /** Take one ref-counted hold. */
  hold(name: string): void {
    const prev = this.counts.get(name) ?? 0;
    this.counts.set(name, prev + 1);
    if (prev === 0) this.emit();
  }

  /** Drop one hold; releasing an absent name is a safe no-op (backstops). */
  release(name: string): void {
    const prev = this.counts.get(name);
    if (prev === undefined) return;
    if (prev <= 1) {
      this.counts.delete(name);
      this.emit();
    } else {
      this.counts.set(name, prev - 1);
    }
  }

  /** Level-triggered hold for a state stream: never stacks, `off` fully clears. */
  signal(name: string, on: boolean): void {
    const held = this.counts.has(name);
    if (on === held) return;
    if (on) {
      this.counts.set(name, 1);
    } else {
      this.counts.delete(name);
    }
    this.emit();
  }

  /** Run `fn` under a hold released on every exit path (throw included). */
  async with<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.hold(name);
    try {
      return await fn();
    } finally {
      this.release(name);
    }
  }

  private emit(): void {
    this.onChange?.(this.counts.size > 0, this.holds());
  }
}
