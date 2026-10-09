/**
 * InstagramAdapter — the versioned facade over the two DOM/URL-touching roles.
 *
 * - `actor`   : the ONLY DOM-touching code (follow / unfollow / scroll).
 * - `sentinel`: block / challenge / logged-out detection.
 *
 * The Reader (network-response parsing) is NOT held here: it is pure and
 * stateless, so the composition root and the rim hold a `Reader` directly.
 *
 * `adapterVersion` echoes the active surface's capture provenance so the app
 * can log which Instagram surface these selectors were verified against.
 */

import type { ActivityReporter } from '@/adapter/activity-reporter';
import { Actor, type ActorInteractor, type AdapterTab } from '@/adapter/actor';
import { SURFACE } from '@/adapter/ig-surface';
import { Sentinel } from '@/adapter/sentinel';

/** Adapter construction options. */
export interface InstagramAdapterOptions {
  /**
   * Input engine: every Actor click/scroll is dispatched as native input
   * events through it (see `src/interaction/`). Required — there is no in-page
   * click tier.
   */
  interactor: ActorInteractor;
  /**
   * Provider of the ACTIVE driver's abort signal — a `stop()` interrupts the
   * Actor's in-flight DOM polls instead of sitting out their timeouts.
   */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil (page-driving phases); optional. */
  reporter?: ActivityReporter;
}

export class InstagramAdapter {
  readonly actor: Actor;
  readonly sentinel: Sentinel;
  readonly adapterVersion: string = SURFACE.version;

  constructor(tab: AdapterTab, opts: InstagramAdapterOptions) {
    this.actor = new Actor(tab, {
      interactor: opts.interactor,
      abortSignal: opts.abortSignal,
      reporter: opts.reporter,
    });
    this.sentinel = new Sentinel(tab);
  }
}
