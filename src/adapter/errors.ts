/**
 * Adapter error types.
 *
 * `AdapterStaleError` is thrown whenever an expected DOM contact point (a
 * selector or text-matched control from the active surface version module) is
 * absent. Instagram
 * rotates obfuscated class names and occasionally reshapes its DOM; when that
 * happens we want the failure to be LOUD and attributable — never a silently
 * swallowed no-op that lets the engine believe an action succeeded.
 */
export class AdapterStaleError extends Error {
  /** The adapter operation that failed, e.g. `actor.follow`. */
  readonly component: string;
  /** The selector / text-matcher that could not be located. */
  readonly selector: string;

  constructor(component: string, selector: string) {
    super(`Adapter stale [${component}]: expected element not found for selector: ${selector}`);
    this.name = 'AdapterStaleError';
    this.component = component;
    this.selector = selector;
    // Restore the prototype chain (required when targeting ES5/ES2022 classes
    // that extend built-ins so `instanceof` keeps working).
    Object.setPrototypeOf(this, AdapterStaleError.prototype);
  }
}
