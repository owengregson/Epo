/**
 * The list walk's end-claim decision, pure: whether a parsed page verifies a
 * probed end, claims an end to probe, continues, or ends a stagnant run.
 */

/** What one parsed page says about the list's continuation. */
export interface WalkPage {
  readonly hasMore: boolean;
  readonly cursor: string | null;
  /** Rows on this page the walk had not observed before. */
  readonly newRows: number;
}

/** The end-claim state the walk carries between pages. */
export interface WalkEndState {
  /** True while this page is the one-past-the-end verification read. */
  readonly probing: boolean;
  /** Consecutive earlier pages that added nothing new. */
  readonly stagnantPages: number;
}

export type StepDecision =
  /** The probe page found nothing new past the claimed end: the end is verified. */
  | { readonly act: 'complete' }
  /** The page claims the end: read one page past it next. */
  | {
      readonly act: 'probe';
      readonly cursor: string;
      readonly stagnantPages: 0;
      /** This page was a probe that carried new rows: the earlier end claim was false. */
      readonly claimWasFalse: boolean;
    }
  | {
      readonly act: 'continue';
      readonly cursor: string;
      readonly stagnantPages: number;
      readonly claimWasFalse: boolean;
    }
  /** Consecutive pages without a new row reached the threshold. */
  | {
      readonly act: 'stop';
      readonly reason: 'stagnant';
      readonly cursor: string;
      readonly stagnantPages: number;
      readonly claimWasFalse: false;
    };

/** Decide what the walk does after a parsed page; `probeCursor` builds the past-the-end offset. */
export function decideStep(
  page: WalkPage,
  state: WalkEndState,
  rowsFetched: number,
  probeCursor: (rows: number) => string,
  stagnantStop: number,
): StepDecision {
  // A pending end claim resolves on THIS page (the past-the-end probe):
  // nothing new past the claimed end = the end is verified; anything new
  // means the claim was FALSE and the walk carries on from here.
  if (state.probing && page.newRows === 0) return { act: 'complete' };
  const claimWasFalse = state.probing;

  if (!page.hasMore || page.cursor === null) {
    // The API claims the list is done. VERIFY before believing it: request
    // one page past the end — via the leftover cursor when one was handed
    // back, else the surface's synthesized offset probe.
    return {
      act: 'probe',
      cursor: page.cursor ?? probeCursor(rowsFetched),
      stagnantPages: 0,
      claimWasFalse,
    };
  }
  // Duplicate-window pages (IG shifts windows on a live list) are
  // tolerated a few in a row; a persistent circle still terminates.
  if (page.newRows !== 0) {
    return { act: 'continue', cursor: page.cursor, stagnantPages: 0, claimWasFalse };
  }
  const stagnantPages = state.stagnantPages + 1;
  if (stagnantPages >= stagnantStop) {
    return { act: 'stop', reason: 'stagnant', cursor: page.cursor, stagnantPages, claimWasFalse: false };
  }
  return { act: 'continue', cursor: page.cursor, stagnantPages, claimWasFalse };
}
