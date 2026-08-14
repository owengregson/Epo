/**
 * InstagramAdapter — the versioned facade over the two DOM/URL-touching roles.
 *
 * - `actor`   : the ONLY DOM-touching code (follow / unfollow / scroll).
 * - `sentinel`: block / challenge / logged-out detection.
 *
 * The Reader (network-response parsing) is NOT held here: it is pure and stateless,
 * so the composition root (Wave 4) and the rim hold the real `Reader` directly (E2).
 *
 * `adapterVersion` echoes the active surface's capture provenance so the app
 * can log which Instagram surface these selectors were verified against.
 */

import { Actor, type ActorHumanizer, type AdapterTab } from '@/adapter/actor';
import { Sentinel } from '@/adapter/sentinel';
import { SURFACE } from '@/adapter/ig-surface';

/** Optional adapter extras (additive; construction without them is unchanged). */
export interface InstagramAdapterOptions {
  /**
   * Human-input engine: when present the Actor clicks/scrolls through real
   * trusted input events instead of in-page JS (see `src/humanizer/`).
   */
  humanizer?: ActorHumanizer;
}

export class InstagramAdapter {
  readonly actor: Actor;
  readonly sentinel: Sentinel;
  readonly adapterVersion: string = SURFACE.version;

  constructor(tab: AdapterTab, opts: InstagramAdapterOptions = {}) {
    this.actor = new Actor(tab, { humanizer: opts.humanizer });
    this.sentinel = new Sentinel(tab);
  }
}
