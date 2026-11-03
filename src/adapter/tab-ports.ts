/**
 * Tab ports — the structural slices of a tab the adapter and rim depend on.
 *
 * `InstagramTab` (`src/adapter/tab.ts`) satisfies all of them; every consumer
 * names the SMALLEST slice it needs so a test fake only implements what is
 * actually driven. One module so the four historical views (`AdapterTab`,
 * `IdentityTab`, `SentinelTab`, `RimTab`) cannot drift apart again — they are
 * now aliases of the unions below.
 */

import type { ResponseHandler, Unsubscribe } from '@/shared/tab-response';

/** In-page script evaluation. */
export interface Evaluable {
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
}

/** The tab's current URL (after redirects) — the Sentinel's primary signal. */
export interface Locatable {
  currentUrl(): string;
}

/** Navigation, plus the two reads that always accompany it. */
export interface Navigable extends Evaluable, Locatable {
  goto(url: string): Promise<void>;
}

/** Network-response observation (CDP-backed on the real tab). */
export interface Observable {
  /** Subscribe to network responses; returns a disposer that removes the handler. */
  onResponse(handler: ResponseHandler): Unsubscribe;
}

/**
 * The response seam as an OPTIONAL member: a plain fake without it keeps the
 * DOM-only path, and code that wants the seam feature-detects it
 * (`typeof tab.onResponse === 'function'`).
 */
export interface MaybeObservable {
  onResponse?(handler: ResponseHandler): Unsubscribe;
}

/**
 * What the Actor and the identity resolver drive: navigate, evaluate, read the
 * URL — and, when the tab has one, observe responses so a follow/unfollow click
 * can be arbitrated by the server's own verdict rather than the header
 * button's optimistic flip.
 */
export type PageTab = Navigable & MaybeObservable;

/** What the Sentinel inspects: no navigation, only the URL and a text probe. */
export type ProbeTab = Evaluable & Locatable;

/** What the rim's collection paths need: a page tab with a guaranteed seam. */
export type ObservedTab = Navigable & Observable;
