/**
 * ProfileObserver — the ONE reader of the profile bodies the tab loads.
 *
 * Instagram's web client reads a profile through the GraphQL
 * `PolarisProfilePageContentQuery` it fires on every profile page load (live
 * 2026-10-08: counts, bio, mutuals and the full `friendship_status`). The REST
 * reads Epo used to COMPOSE were walled one after the other —
 * `web_profile_info` (2026-09-18), then `/users/<pk>/info/` (HTTP 429, empty
 * body, since ~2026-09-20) — and the web client never calls either. So Epo no
 * longer asks for a profile: it VISITS one (`profile-visit.ts`) and this
 * observer reads what the page's own client fetched.
 *
 * Two jobs, ONE parse and ONE write per body:
 *  - always on (PRINCIPLES §1): every profile body the tab loads — the
 *    startup landing on our own page, dialog navigations, visits — is written
 *    to the store the moment it parses;
 *  - expectations: a visit arms {@link ProfileObserver.expect} BEFORE it
 *    navigates, and the same parse wakes it AFTER the store write, so a caller
 *    that reads the store next already sees the fact.
 */

import { ActionAbortedError } from '@/adapter/errors';
import type { Reader } from '@/adapter/reader';
import type { Observable } from '@/adapter/tab-ports';
import type { Clock } from '@/governors/clock';
import type { ProfileSeen } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
import { admits } from '@/surface/read/admission';
import type { Tier } from '@/surface/schema/projection';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import type { TabResponse, Unsubscribe } from '@/types';
import * as logger from '@/utils/logger';

/** An armed wait for one username's next profile body. */
export interface ProfileExpectation {
  /**
   * The profile seen since arming, or `null` when none arrives within
   * `timeoutMs`. Re-callable: a caller may poll in short slices and check the
   * page between them. Throws {@link ActionAbortedError} on `signal`.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<ProfileSeen | null>;
  /** Stop waiting. Idempotent. */
  dispose(): void;
}

export interface ProfileObserverDeps {
  tab: Observable;
  reader: Reader;
  store: Pick<KnowledgeStore, 'observe'>;
  clock: Clock;
  /** Our own pk: names a null relationship's owner (I10) and gates our own header counts. */
  ownPk?: string;
}

/** A read the legacy extractors parsed: the declared container and keys, never partial. */
const LEGACY_READ = { tier: 'canonical', partial: false } as const;

/**
 * Our own header counts are coverage evidence, a destructive input (spec §10.2): only a canonical
 * or normalized, complete read may carry them; any other read of our profile stores no counts.
 */
export function admitOwnCounts(obs: Observation, read: { tier: Tier; partial: boolean }, ownPk: string | undefined): Observation {
  if (obs.accountPk !== ownPk || admits('destructive', read)) return obs;
  return { ...obs, fields: { ...obs.fields, followers: undefined, following: undefined, mutuals: undefined } };
}

export class ProfileObserver {
  private readonly waiting = new Map<string, Set<(seen: ProfileSeen) => void>>();

  constructor(private readonly deps: ProfileObserverDeps) {}

  /** Subscribe to the tab's responses; the disposer unsubscribes. */
  start(): Unsubscribe {
    return this.deps.tab.onResponse((resp) => this.onResponse(resp));
  }

  /** Arm BEFORE navigating: the next profile body whose username is `username`. */
  expect(username: string): ProfileExpectation {
    const key = username.toLowerCase();
    let seen: ProfileSeen | null = null;
    let wake: (() => void) | null = null;
    const listener = (s: ProfileSeen): void => {
      seen = s;
      wake?.();
    };
    const set = this.waiting.get(key) ?? new Set<(seen: ProfileSeen) => void>();
    set.add(listener);
    this.waiting.set(key, set);

    return {
      next: async (timeoutMs, signal) => {
        if (seen !== null) return seen;
        if (signal?.aborted) throw new ActionAbortedError('profile.visit');
        let onAbort: (() => void) | null = null;
        const arrival = new Promise<'seen' | 'aborted'>((resolve) => {
          wake = () => resolve('seen');
          if (signal) {
            onAbort = () => resolve('aborted');
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        try {
          const winner = await withTimeout(arrival, timeoutMs);
          if (winner === 'aborted') throw new ActionAbortedError('profile.visit');
          return winner === TIMED_OUT ? null : seen;
        } finally {
          wake = null;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
      },
      dispose: () => {
        set.delete(listener);
        if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
      },
    };
  }

  private onResponse(resp: TabResponse): void {
    const { reader } = this.deps;
    const kind = reader.profileKindOf(resp);
    if (kind === null) return;
    // The GraphQL profile body is served as `text/javascript`, not JSON — the
    // mime gate has to accept it or every profile read is dropped.
    if (resp.status >= 400 || !reader.parseableBody(resp.mimeType)) return;
    resp
      .getBody()
      .then((body) => {
        const parsed = reader.parseProfileInfo(body, this.deps.clock.now(), kind);
        if (parsed === null) return;
        const presence = reader.profilePresence(body, kind, this.deps.ownPk ?? null) ?? undefined;
        if (presence?.counts === 'partial' || presence?.counts === 'invalid') {
          // A count pair that does not read is drift: the profile is stored without counts.
          logger.warn('rim.profile-observer: profile counts unreadable, stored without them', { counts: presence.counts });
        }
        const obs = admitOwnCounts(parsed, LEGACY_READ, this.deps.ownPk);
        this.deps.store.observe(obs);
        const listeners = this.waiting.get(obs.fields.username?.toLowerCase() ?? '');
        if (listeners === undefined) return;
        const seen: ProfileSeen = { obs, viewer: reader.profileViewer(body, kind), presence, ...LEGACY_READ };
        for (const listener of [...listeners]) listener(seen);
      })
      .catch((e: unknown) => {
        logger.warn('rim.profile-observer: profile body unreadable', { error: String(e) });
      });
  }
}
