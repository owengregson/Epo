/**
 * The read pipeline's shared vocabulary (spec Appendix D.1). A normalized step records each
 * declared non-canonical form a read passed through, so the read reports as C1, never C0.
 */

/** A declared non-canonical form: framing, an alternate container, an alias key, a retype, a root-field route. */
export type StepKind = 'framing' | 'alternate-container' | 'alias-key' | 'retype' | 'root-field-route';

/** Which wall a response is: a rate limit, a session wall, or server errors to wait out. */
export type WallFamily = 'rate-limited' | 'auth' | 'server-error';

/** One normalized step: what fired, where (a path pattern, never a value), and a short detail. */
export interface NormalizeStep {
  readonly kind: StepKind;
  readonly at: string;
  readonly detail?: string;
}
