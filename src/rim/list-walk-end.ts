/**
 * The list walk's decision table (spec §10.4), pure: what the walk does after one parsed page.
 * An end is complete only on a verified probe or, in an opaque cursor space, on the server's own
 * false flags with no veto — never on a second synthesized offset.
 */

import type { Continuation } from '@/surface/schema/projection';

/** The cursor form the walk has seen (sticky: any opaque cursor makes the space opaque), and whether this page is a probe. */
export interface WalkCursorState {
  readonly lastForm: 'none' | 'offset' | 'opaque';
  readonly probing: boolean;
}

/** Why a walk stopped short of an end (every stop is reported as `shape-mismatch` plus this detail). */
export type StopDetail = 'more-without-cursor' | 'incomplete-stream' | 'cursor-veto' | 'no-continuation-evidence'
  | 'end-claim-false' | 'rows-unreadable';

export type StepDecision =
  | { readonly act: 'continue'; readonly cursor: string; readonly form: 'offset' | 'opaque' }
  /** Read one page past the claimed end, at the synthesized offset; `plainForm` drops the fixed order. */
  | { readonly act: 'probe'; readonly cursor: string; readonly plainForm: boolean }
  | { readonly act: 'complete'; readonly endEvidence: 'probe' | 'server-flags' }
  | { readonly act: 'stop'; readonly reason: 'shape-mismatch'; readonly detail: StopDetail };

const stop = (detail: StopDetail): StepDecision => ({ act: 'stop', reason: 'shape-mismatch', detail });

/** The form after a cursor: an opaque cursor makes the space opaque for the rest of the walk. */
export function nextForm(lastForm: WalkCursorState['lastForm'], form: 'offset' | 'opaque'): WalkCursorState['lastForm'] {
  return lastForm === 'opaque' || form === 'opaque' ? 'opaque' : 'offset';
}

/** Decide after a parsed page; `probeCursor` builds the past-the-end offset for `rowsFetched` rows. */
export function decideStep(
  page: { readonly continuation: Continuation; readonly newRows: number },
  state: WalkCursorState,
  form: 'paged' | 'whole-list',
  rowsFetched: number,
  probeCursor: (rows: number) => string,
): StepDecision {
  const c = page.continuation;
  if (c.kind === 'drift') return stop(c.reason);
  if (state.probing) {
    if (page.newRows === 0) return { act: 'complete', endEvidence: 'probe' };
    // New rows past a claimed end: follow the server's own cursor, or stop — never guess again.
    return form === 'paged' && c.kind === 'next' ? { act: 'continue', cursor: c.cursor, form: c.form } : stop('end-claim-false');
  }
  if (form === 'whole-list') return { act: 'probe', cursor: probeCursor(rowsFetched), plainForm: true };
  if (c.kind === 'next') return { act: 'continue', cursor: c.cursor, form: c.form };
  if (state.lastForm !== 'opaque') return { act: 'probe', cursor: probeCursor(rowsFetched), plainForm: false };
  // An offset probe cannot verify an opaque space: the server's false flags decide, unless vetoed.
  if (c.evidence === 'no-flags') return stop('no-continuation-evidence');
  return c.vetoKey === undefined ? { act: 'complete', endEvidence: 'server-flags' } : stop('cursor-veto');
}
