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
 *    navigates, and the same read wakes it AFTER the store write. A body that
 *    names no profile — a wall, drift, or "gone" — wakes every armed visit
 *    (the visitor is serialized: one armed expectation at a time).
 */

import { ActionAbortedError } from '@/adapter/errors';
import type { Reader } from '@/adapter/reader';
import type { Observable } from '@/adapter/tab-ports';
import type { Clock } from '@/governors/clock';
import type { ProfileSeen } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { SurfaceRead, WallFamily } from '@/surface/read/types';
import type { DriftClass } from '@/surface/sink';
import { TIMED_OUT, withTimeout } from '@/timing/primitives';
import type { TabResponse, Unsubscribe } from '@/types';
import * as logger from '@/utils/logger';

/** What an armed visit can learn from the page's profile reads. */
export type ExpectationEvent =
  | { readonly kind: 'seen'; readonly seen: ProfileSeen }
  | { readonly kind: 'wall'; readonly family: WallFamily; readonly status: number }
  | { readonly kind: 'drift'; readonly cls: DriftClass }
  /** The declared container present and null, no errors, a final body: Instagram says the profile is gone. */
  | { readonly kind: 'absent' };

/** An armed wait for one username's profile read. */
export interface ProfileExpectation {
  /**
   * The next event since arming (in arrival order), or `null` when none arrives within
   * `timeoutMs`. Re-callable: a caller may poll in short slices and check the page between them.
   * Throws {@link ActionAbortedError} on `signal`.
   */
  next(timeoutMs: number, signal?: AbortSignal): Promise<ExpectationEvent | null>;
  /** Stop waiting. Idempotent. */
  dispose(): void;
}

export interface ProfileObserverDeps {
  tab: Observable;
  reader: Reader;
  store: Pick<KnowledgeStore, 'observe'>;
  clock: Clock;
  /** Our own pk: our own header counts are kept only from a canonical or normalized, complete read. */
  ownPk?: string;
}

type Listener = (event: ExpectationEvent) => void;

/**
 * What a read that names no profile tells an armed visit: a wall is a wall (errors without the profile
 * wait like one, spec §10.5); only Instagram's explicit null in a clean, complete body is "gone"; a
 * stream that is not final knows nothing yet; anything else is drift. A 404 or non-data answer is no news.
 */
function noProfile(read: SurfaceRead): ExpectationEvent | null {
  if (!read.ok) {
    if (read.kind === 'wall') return { kind: 'wall', family: read.family, status: read.status };
    return read.kind === 'http-absent' || read.kind === 'not-data' ? null : { kind: 'drift', cls: read.kind };
  }
  if (read.projection.absent === true) return { kind: 'absent' };
  return { kind: 'drift', cls: read.partial ? 'incomplete-stream' : 'row-issue' };
}

export class ProfileObserver {
  private readonly waiting = new Map<string, Set<Listener>>();
  /** Every armed listener, for the bodies that name no profile. */
  private readonly armed = new Set<Listener>();

  constructor(private readonly deps: ProfileObserverDeps) {}

  /** Subscribe to the tab's responses; the disposer unsubscribes. */
  start(): Unsubscribe {
    return this.deps.tab.onResponse((resp) => this.onResponse(resp));
  }

  /** Arm BEFORE navigating: the reads that answer a visit to `username`. */
  expect(username: string): ProfileExpectation {
    const key = username.toLowerCase();
    const queue: ExpectationEvent[] = [];
    let wake: (() => void) | null = null;
    const listener: Listener = (event) => {
      queue.push(event);
      wake?.();
    };
    const set = this.waiting.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.waiting.set(key, set);
    this.armed.add(listener);

    return {
      next: async (timeoutMs, signal) => {
        if (queue.length > 0) return queue.shift() ?? null;
        if (signal?.aborted) throw new ActionAbortedError('profile.visit');
        let onAbort: (() => void) | null = null;
        const arrival = new Promise<'event' | 'aborted'>((resolve) => {
          wake = () => resolve('event');
          if (signal) {
            onAbort = () => resolve('aborted');
            signal.addEventListener('abort', onAbort, { once: true });
          }
        });
        try {
          const winner = await withTimeout(arrival, timeoutMs);
          if (winner === 'aborted') throw new ActionAbortedError('profile.visit');
          return winner === TIMED_OUT ? null : (queue.shift() ?? null);
        } finally {
          wake = null;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
      },
      dispose: () => {
        set.delete(listener);
        this.armed.delete(listener);
        if (set.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
      },
    };
  }

  /** Wake every armed visit with a read that names no profile. */
  private toArmed(event: ExpectationEvent): void {
    for (const listener of [...this.armed]) listener(event);
  }

  private onResponse(resp: TabResponse): void {
    if (this.deps.reader.profileKindOf(resp) === null) return;
    // One read per response, shared with every other consumer of the same body.
    this.deps.reader.observed.read(resp, this.deps.clock.now())
      ?.then(({ read }) => this.read(read))
      .catch((e: unknown) => {
        logger.warn('rim.profile-observer: profile body unreadable', { error: String(e) });
      });
  }

  private read(read: SurfaceRead): void {
    const seen = this.deps.reader.profileSeen(read, this.deps.ownPk ?? null);
    if (seen === null) {
      const event = noProfile(read);
      if (event !== null) this.toArmed(event);
      return;
    }
    const counts = seen.presence?.counts;
    if (counts === 'partial' || counts === 'invalid') {
      // A count pair that does not read is drift: the profile is stored without counts.
      logger.warn('rim.profile-observer: profile counts unreadable, stored without them', { counts });
    }
    this.deps.store.observe(seen.obs);
    const listeners = this.waiting.get(seen.obs.fields.username?.toLowerCase() ?? '');
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener({ kind: 'seen', seen });
  }
}
