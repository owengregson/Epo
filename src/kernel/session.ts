/**
 * A capability that APPEARS and VANISHES — and the dependents built around it.
 *
 * The single hardest thing in `foundation-wiring.ts` is that the knowledge
 * graph does not exist until the `ds_user_id` cookie resolves. That one fact
 * produced six mutable fields (`ensureBuilt` / `buildPromise` / `ownPkCache` /
 * `disposing` / `tearingDown` / `graph`) consulted by ~40 `if (graph === null)`
 * guards spread over every method in the file.
 *
 * A `Session<T>` names the transition instead of testing for it. Nothing reads
 * `graph === null` to decide whether to construct something: a dependent
 * declares that it needs the session, is BUILT when the session opens, and is
 * DISPOSED when it closes ({@link bindToSession}). The remaining `current()`
 * callers are the ones that genuinely have a not-built answer to give (a
 * projection served while logged out).
 *
 * See ADR 1007.
 */

import type { Lifetime } from './module';

/** The read side: what a dependent may do with a session it did not open. */
export interface Session<T> {
  /** The live value, or `null` while the session is closed. */
  current(): T | null;
  /** Notified on every open (never for the value already current). Returns an unsubscribe. */
  onOpen(cb: (value: T) => void): () => void;
  /** Notified on every close, with the value that closed. Returns an unsubscribe. */
  onClose(cb: (value: T) => void): () => void;
}

/** The write side: held by the module that OWNS the capability, and nobody else. */
export interface MutableSession<T> extends Session<T> {
  /**
   * Publish `value`. Opening over a DIFFERENT live value closes the old one
   * first (one close, then one open — the identity swap a re-login is).
   * Re-opening the identical value is a no-op.
   */
  open(value: T): void;
  /** Retract the live value. A no-op while already closed. */
  close(): void;
}

/** A session nobody has opened yet. */
export function createSession<T>(): MutableSession<T> {
  let value: T | null = null;
  const opens = new Set<(v: T) => void>();
  const closes = new Set<(v: T) => void>();

  const add = <C>(set: Set<C>, cb: C): (() => void) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };

  const close = (): void => {
    const closing = value;
    if (closing === null) return;
    value = null;
    // A snapshot: a listener that unsubscribes during the notification must
    // not shorten the round it is already part of.
    for (const cb of [...closes]) cb(closing);
  };

  return {
    current: () => value,
    onOpen: (cb) => add(opens, cb),
    onClose: (cb) => add(closes, cb),
    open: (next) => {
      if (value === next) return;
      close();
      value = next;
      for (const cb of [...opens]) cb(next);
    },
    close,
  };
}

/** The live dependent of a session, plus the handle that unbinds it. */
export interface SessionBinding<R> {
  /** The dependent built for the current session, or `null` while closed. */
  current(): R | null;
  /** Resolves once every open/close transition seen so far has been applied. */
  settled(): Promise<void>;
  /** Unbind and dispose the live dependent (if any). Idempotent. */
  dispose(): Promise<void>;
}

/**
 * THE RULE: a dependent declared over a session is built on open and disposed
 * on close.
 *
 * `factory` runs once per open; the result's `start()` — if it has one; a
 * dependent may be a plain value — is awaited before the binding counts as
 * settled, and its `dispose()` runs on the matching close.
 * Transitions are serialized on one internal chain, so a close that lands
 * while an open is still starting never races it — the ordering `Foundation`
 * hand-maintains today with `buildPromise` + `tearingDown`.
 *
 * Binding to an ALREADY-OPEN session builds immediately: a module composed
 * after login must not wait for a logout to notice the graph exists.
 */
export function bindToSession<T, R extends object>(
  session: Session<T>,
  factory: (value: T) => R,
  onError?: (phase: 'start' | 'dispose', error: unknown) => void,
): SessionBinding<R> {
  let live: R | null = null;
  let chain: Promise<void> = Promise.resolve();
  let unbound = false;

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task, task);
    return chain;
  };

  const openNow = (value: T): Promise<void> =>
    enqueue(async () => {
      if (unbound || live !== null) return;
      const built = factory(value);
      live = built;
      try {
        await (built as Partial<Lifetime>).start?.();
      } catch (e) {
        onError?.('start', e);
      }
    });

  const closeNow = (): Promise<void> =>
    enqueue(async () => {
      const built = live;
      live = null;
      if (built === null) return;
      try {
        await (built as Partial<Lifetime>).dispose?.();
      } catch (e) {
        onError?.('dispose', e);
      }
    });

  const unsubOpen = session.onOpen((value) => {
    void openNow(value);
  });
  const unsubClose = session.onClose(() => {
    void closeNow();
  });

  const already = session.current();
  if (already !== null) void openNow(already);

  return {
    current: () => live,
    settled: () => chain,
    dispose: async () => {
      unbound = true;
      unsubOpen();
      unsubClose();
      await closeNow();
    },
  };
}
