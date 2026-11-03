/**
 * The surface gate (spec §10.6): which activities pause while the delivery of the facts they decide
 * on has changed and is unconfirmed. Phase F lands the port with a never-paused default; the
 * parse-health stream supplies the real gate. Renderer-safe and pure.
 */

/** Activities a drifted surface pauses (internal ids; user copy lives with the renderer). */
export type PausedActivity = 'unfollows' | 'relationship-reads' | 'cleanup' | 'follow-back-decisions' | 'exploration';

export interface SurfaceGate {
  paused(activity: PausedActivity): boolean;
}

/** The default until the real gate is wired: nothing is paused (today's behaviour). */
export const NEVER_PAUSED: SurfaceGate = { paused: () => false };
