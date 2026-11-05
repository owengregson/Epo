/**
 * What fills the window region right of the console: the embedded IG tab, or a stage that covers it (People,
 * Graph, Prune, Settings) while the tab keeps running underneath. The shell (main) swaps the view and the
 * renderer asks for the swap: one vocabulary, shared, with its guard.
 */
export const STAGE_MODES = ['tab', 'people', 'graph', 'prune', 'settings'] as const;
export type StageMode = (typeof STAGE_MODES)[number];

/** True for a known stage; the stage channel refuses anything else. */
export function isStageMode(v: unknown): v is StageMode {
  return typeof v === 'string' && (STAGE_MODES as readonly string[]).includes(v);
}
