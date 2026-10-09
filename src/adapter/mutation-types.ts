/**
 * The follow/unfollow mutation vocabulary — a LEAF module (no imports), so the
 * version modules that implement it and `ig-surface.ts` that publishes it can
 * both depend on it without closing a cycle. Re-exported from `ig-surface.ts`.
 */

/** The two relationship mutations the action button fires. */
export type MutationKind = 'follow' | 'unfollow';

/** What the tab knows about a request when its response arrives. */
export interface MutationRequest {
  url: string;
  /** HTTP method when the observer saw the request go out. */
  method?: string;
  /** Request headers, keys lower-cased (see `TabResponse.requestHeaders`). */
  requestHeaders?: Record<string, string>;
}

/** A recognised mutation request: which action, and the subject pk when the URL carries it. */
export interface MutationMatch {
  kind: MutationKind;
  pk: string | null;
}

/** The server's own verdict, read out of a mutation response body. */
export interface MutationVerdict {
  verdict: 'ok' | 'fail';
  /** e.g. `following` / `requested` on an ok follow; null when the body has none. */
  result: string | null;
  /** The machine message on failure (e.g. `feedback_required`); null when absent. */
  message: string | null;
  /** Human feedback text (title + message) when the body carries any; null otherwise. */
  feedbackText: string | null;
  /** Instagram's explicit throttle flag. */
  spam: boolean;
}
