/**
 * Structured concurrency: one lifetime tree, one place cancellation lives.
 *
 * Today the same job is done by four mechanisms that have to agree —
 * `AbortController`, generation tokens (`superseded(token)`), `owedResume` /
 * `parkedNow` / `awaitParked`, and ad-hoc `finally` blocks. A `Scope` replaces
 * them: work runs under a scope, resources are acquired THROUGH it, and closing
 * it aborts the signal, closes children first, then releases every resource in
 * reverse order. A child cannot outlive its parent, which is what the generation
 * token was approximating.
 *
 * Deliberately timer-free (Promise + AbortController only), so the kernel keeps
 * no clock and this file is trivially testable. Durable time — a hold that must
 * survive `app.quit()` — is Chronos's job, not a scope's (ADR 0603).
 */

/** Something with a lifetime. `acquire` may use the scope (e.g. its signal). */
export interface Resource<T> {
  readonly acquire: (scope: Scope) => T | Promise<T>;
  readonly release: (value: T) => void | Promise<void>;
}

export interface Scope {
  /** Path-shaped and unique: `root/growth#1/walk#2`. Goes straight into a span. */
  readonly id: string;
  /** Aborted at the START of `close`, before any finalizer runs. */
  readonly signal: AbortSignal;
  /** A nested scope. Throws once this scope is closing — no orphans. */
  child(name: string): Scope;
  /** Acquire under this scope. A failing acquire closes the scope and rethrows. */
  use<T>(resource: Resource<T>): Promise<T>;
  /** Idempotent. Repeat calls return the same promise as the first. */
  close(reason?: string): Promise<void>;
  closed(): boolean;
}

/** Thrown when a closed (or closing) scope is asked to own more work. */
export class ScopeClosedError extends Error {
  constructor(id: string) {
    super(`scope ${id} is closed`);
    this.name = 'ScopeClosedError';
  }
}

class ScopeImpl implements Scope {
  readonly id: string;
  private readonly controller = new AbortController();
  private readonly children: ScopeImpl[] = [];
  private readonly finalizers: Array<() => Promise<void>> = [];
  private closing: Promise<void> | null = null;
  private seq = 0;

  constructor(
    id: string,
    private readonly parent: ScopeImpl | null,
  ) {
    this.id = id;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  closed(): boolean {
    return this.closing !== null;
  }

  child(name: string): Scope {
    if (this.closing) throw new ScopeClosedError(this.id);
    this.seq += 1;
    const c = new ScopeImpl(`${this.id}/${name}#${this.seq}`, this);
    this.children.push(c);
    return c;
  }

  async use<T>(resource: Resource<T>): Promise<T> {
    if (this.closing) throw new ScopeClosedError(this.id);
    let value: T;
    try {
      value = await resource.acquire(this);
    } catch (e) {
      // Everything acquired before this one is still owed a release. A failure
      // in that sweep joins the original error rather than replacing it.
      const failures: unknown[] = [e];
      try {
        await this.close('acquire-failed');
      } catch (closeError) {
        failures.push(closeError);
      }
      if (failures.length === 1) throw e;
      throw new AggregateError(failures, `acquire failed in scope ${this.id}`);
    }
    if (this.closing) {
      // Closed while we awaited: this resource missed the finalizer sweep.
      await resource.release(value);
      throw new ScopeClosedError(this.id);
    }
    this.finalizers.push(async () => {
      await resource.release(value);
    });
    return value;
  }

  close(reason = 'closed'): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.runClose(reason);
    return this.closing;
  }

  /**
   * Abort → children (newest first) → finalizers (reverse acquisition order).
   * Every step runs even if an earlier one threw; the failures are reported
   * together as an `AggregateError` rather than swallowed.
   */
  private async runClose(reason: string): Promise<void> {
    this.controller.abort(reason);
    const errors: unknown[] = [];
    for (const c of [...this.children].reverse()) {
      try {
        await c.close(reason);
      } catch (e) {
        errors.push(e);
      }
    }
    this.children.length = 0;
    for (const f of [...this.finalizers].reverse()) {
      try {
        await f();
      } catch (e) {
        errors.push(e);
      }
    }
    this.finalizers.length = 0;
    this.parent?.forget(this);
    if (errors.length > 0) throw new AggregateError(errors, `scope ${this.id} finalizers failed`);
  }

  private forget(child: ScopeImpl): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }
}

/** The top of a lifetime tree. One per run, per window, per test. */
export const rootScope = (name = 'root'): Scope => new ScopeImpl(name, null);
