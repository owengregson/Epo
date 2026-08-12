/**
 * Rim types — the narrow seams between the pure engine and live Instagram.
 *
 * The adapter-backed rim (Wave 2) implements the engine's ports against a real
 * tab + Adapter. Every rim class depends on the SMALLEST slice of the tab it
 * needs, so tests can fake it without an Electron `WebContentsView`.
 */

import type { ResponseHandler, Unsubscribe } from '@/types';

/**
 * The minimal port-tab every rim class depends on: navigation, in-page eval, a
 * network-response subscription, and the current URL. `InstagramTab` (from
 * `src/adapter/tab.ts`) satisfies this by structural subtyping; tests supply a
 * fake with the same four members.
 */
export interface RimTab {
  goto(url: string): Promise<void>;
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  /** Subscribe to network responses; returns a disposer that removes the handler. */
  onResponse(handler: ResponseHandler): Unsubscribe;
  currentUrl(): string;
}

/**
 * The follower-acquisition port (§2, NEW). One implementation (the adapter-backed
 * `AdapterBackedAcquisition`) is shared by the manual `readFollowers` IPC path and
 * the Engine's automated pool-refill, so the scraping loop lives in exactly one
 * place.
 */
export interface FollowerAcquisition {
  acquire(targetUsername: string): Promise<{ observed: number; targetPk: string | null }>;
}
