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
import { Actor, type ActorInteractor, type ActorOptions, type AdapterTab } from '@/adapter/actor';
import { SURFACE } from '@/adapter/ig-surface';
import { Sentinel } from '@/adapter/sentinel';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { type SleepFn, sample, sleep } from '@/timing/primitives';

/** Adapter construction options. */
export interface InstagramAdapterOptions {
  prepareProfile?: (username: string, expectedPk: string, action: 'follow' | 'unfollow') => Promise<void>;
  beforeMutation?: () => Promise<void>;
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
  /** The tempo the adapter's reading pauses resolve from (default: the reference tempo). */
  tempo?: TempoSource;
}

export class InstagramAdapter {
  readonly actor: Actor;
  readonly sentinel: Sentinel;
  readonly adapterVersion: string = SURFACE.version;

  constructor(tab: AdapterTab, opts: InstagramAdapterOptions) {
    const tempo = tempoOrReference(opts.tempo);
    this.actor = new Actor(tab, {
      prepareProfile: lookBeforeActing(opts.prepareProfile, tempo, opts.abortSignal),
      beforeMutation: opts.beforeMutation,
      interactor: opts.interactor,
      abortSignal: opts.abortSignal,
      reporter: opts.reporter,
      tempo,
    });
    this.sentinel = new Sentinel(tab);
  }
}

/** Look before acting: after the fresh visit lands, a reading pause (`dwell.before-press`) before the dispatch. */
export function lookBeforeActing(review: ActorOptions['prepareProfile'], tempo: TempoSource,
  abortSignal?: () => AbortSignal | undefined, pause: SleepFn = sleep): ActorOptions['prepareProfile'] {
  if (review === undefined) return undefined;
  return async (username, expectedPk, action) => {
    await review(username, expectedPk, action);
    if (tempo.enabled('dwell.before-press')) await pause(sample(tempo.policy('dwell.before-press')), abortSignal?.());
  };
}
