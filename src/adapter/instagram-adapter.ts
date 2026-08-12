/**
 * InstagramAdapter — the versioned facade over the three adapter roles.
 *
 * - `reader`  : network-response parsing (built by a parallel task; wired in
 *               during integration — left as an optional slot here).
 * - `actor`   : the ONLY DOM-touching code (follow / unfollow / scroll).
 * - `sentinel`: block / challenge / logged-out detection.
 *
 * `adapterVersion` echoes the field-notes capture provenance so the app can log
 * which Instagram surface these selectors were verified against.
 */

import { Actor, type AdapterTab } from '@/adapter/actor';
import { Sentinel } from '@/adapter/sentinel';
import { ADAPTER_VERSION } from '@/adapter/field-notes';

export class InstagramAdapter {
  readonly actor: Actor;
  readonly sentinel: Sentinel;
  readonly adapterVersion: string = ADAPTER_VERSION;

  /**
   * The Reader is implemented by a parallel task. It is left as an optional
   * slot so this facade type-checks and constructs standalone; integration
   * assigns it once available. Typed loosely on purpose (no reader.ts import).
   */
  reader?: unknown;

  constructor(tab: AdapterTab) {
    this.actor = new Actor(tab);
    this.sentinel = new Sentinel(tab);
  }
}
