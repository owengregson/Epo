/**
 * The tab's network-observation contract: one observed response from the
 * embedded Instagram tab, plus the subscription verbs around it.
 *
 * The tab observes responses over the Chrome DevTools Protocol
 * (`src/adapter/tab.ts`); the rim readers, the mutation watch and the capture
 * harness consume them. Pure and dependency-free, so a consumer can name the
 * shape without importing the tab — which is what let `src/types.ts` sit in
 * every module cycle the boundaries gate reports (ADR 1040). The adapter may
 * adopt this file into `src/adapter/tab-ports.ts`; until then it is the one
 * home.
 */

/**
 * A single observed network response from the embedded Instagram tab.
 *
 * `getBody()` lazily fetches the decoded response body so the Reader only pays
 * for bodies it actually wants to parse.
 */
export interface TabResponse {
  /** CDP request identifier; unique within the tab's page session. */
  requestId: string;
  /** Fully-qualified response URL. */
  url: string;
  /** HTTP status code. */
  status: number;
  /** Response MIME type (e.g. `application/json`). */
  mimeType: string;
  /**
   * The request's HTTP method (from `Network.requestWillBeSent`), when the
   * observer saw the request go out. Absent for responses whose request
   * predates the observer (a debugger re-attach mid-flight).
   */
  method?: string;
  /**
   * The request headers the page sent, keys LOWER-CASED. Lets a consumer tell
   * a GraphQL mutation apart from a query by its friendly-name header without
   * the tab knowing any Instagram literal. Absent when `method` is.
   */
  requestHeaders?: Record<string, string>;
  /**
   * Lazily fetch the decoded response body as a UTF-8 string.
   * Rejects if the body is no longer available in the CDP resource cache.
   */
  getBody(): Promise<string>;
}

/** Handler registered via the tab's `onResponse`. */
export type ResponseHandler = (response: TabResponse) => void;

/** Disposer returned by subscription helpers; idempotent. */
export type Unsubscribe = () => void;
