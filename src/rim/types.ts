/**
 * Rim types — the narrow seams between the pure engine and live Instagram.
 *
 * The adapter-backed rim (Wave 2) implements the engine's ports against a real
 * tab + Adapter. Every rim class depends on the SMALLEST slice of the tab it
 * needs, so tests can fake it without an Electron `WebContentsView`.
 */

import type { ObservedTab } from '@/adapter/tab-ports';

/**
 * The port-tab every rim class depends on: navigation, in-page eval, the
 * current URL, and a guaranteed network-response subscription (the collection
 * paths read their facts off intercepted responses). `InstagramTab` satisfies
 * it structurally; tests supply a fake with the same members.
 */
export type RimTab = ObservedTab;

/**
 * The follower-acquisition port (§2, NEW). One implementation (the adapter-backed
 * `AdapterBackedAcquisition`) is shared by the manual `readFollowers` IPC path and
 * the Engine's own pool-refill, so the collection loop lives in exactly one
 * place.
 */
export interface FollowerAcquisition {
  acquire(targetUsername: string): Promise<{ observed: number; targetPk: string | null }>;
}
