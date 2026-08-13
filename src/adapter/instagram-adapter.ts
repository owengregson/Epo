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

import { Actor, type AdapterTab } from '@/adapter/actor';
import { Sentinel } from '@/adapter/sentinel';
import { SURFACE } from '@/adapter/ig-surface';

export class InstagramAdapter {
  readonly actor: Actor;
  readonly sentinel: Sentinel;
  readonly adapterVersion: string = SURFACE.version;

  constructor(tab: AdapterTab) {
    this.actor = new Actor(tab);
    this.sentinel = new Sentinel(tab);
  }
}
