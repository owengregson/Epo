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
import { SURFACE } from '@/adapter/ig-surface';
import type { ProfileKind, Reader } from '@/adapter/reader';
import type { Observable } from '@/adapter/tab-ports';
import type { Clock } from '@/governors/clock';
import type { ProfileSeen } from '@/rim/profile-visit-port';
import type { KnowledgeStore } from '@/store/knowledge-store';
import type { Observation } from '@/store/types';
import { admits } from '@/surface/read/admission';
import { gateObserved } from '@/surface/read/gate';
import type { WallFamily } from '@/surface/read/types';
import type { Tier } from '@/surface/schema/projection';
import type { DriftClass } from '@/surface/sink';
import { decodeBody } from '@/surface/transport/decode';
import type { GraphqlOutcome } from '@/surface/transport/graphql';
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
  /** Our own pk: names a null relationship's owner (I10) and gates our own header counts. */
  ownPk?: string;
}

/**
 * Our own header counts are coverage evidence, a destructive input (spec §10.2): only a canonical
 * or normalized, complete read may carry them; any other read of our profile stores no counts.
 */
export function admitOwnCounts(obs: Observation, read: { tier: Tier; partial: boolean }, ownPk: string | undefined): Observation {
  if (obs.accountPk !== ownPk || admits('destructive', read)) return obs;
  return { ...obs, fields: { ...obs.fields, followers: undefined, following: undefined, mutuals: undefined } };
}

type Listener = (event: ExpectationEvent) => void;

/**
 * What a body that carries no profile tells an armed visit: a non-final stream is drift; a wall is a
 * wall; errors without the profile wait like one (spec §10.5); only a clean, complete body whose
 * container is explicitly null is "gone"; anything else is drift.
 */
function noProfile(envelope: GraphqlOutcome, streaming: boolean, status: number, absent: () => boolean): ExpectationEvent {
  if (streaming) return { kind: 'drift', cls: 'incomplete-stream' };
  if (envelope.kind === 'wall') {
    return { kind: 'wall', family: envelope.status === 'action-blocked' ? 'rate-limited' : 'auth', status };
  }
  if (envelope.kind === 'error') return { kind: 'wall', family: 'server-error', status };
  return absent() ? { kind: 'absent' } : { kind: 'drift', cls: 'mismatch' };
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
    const kind = this.deps.reader.profileKindOf(resp);
    if (kind === null) return;
    // A wall is never drift: an HTTP or HTML wall answers the armed visit before any body read.
    const gate = gateObserved(resp.status, resp.mimeType, SURFACE.transport.parseableMime);
    if (gate.kind === 'wall') {
      this.toArmed({ kind: 'wall', family: gate.family, status: resp.status });
      return;
    }
    if (gate.kind !== 'data') return;
    resp
      .getBody()
      .then((body) => this.read(body, kind, resp.status))
      .catch((e: unknown) => {
        logger.warn('rim.profile-observer: profile body unreadable', { error: String(e) });
      });
  }

  private read(body: string, kind: ProfileKind, status: number): void {
    const { reader } = this.deps;
    const decoded = decodeBody(body, SURFACE.transport);
    const envelope = reader.profileEnvelope(body, kind);
    const streaming = decoded.ok && decoded.final === false;
    const errorOnly = envelope.kind === 'wall' || envelope.kind === 'error';
    const parsed = streaming || errorOnly ? null : reader.parseProfileInfo(body, this.deps.clock.now(), kind);
    const read = { tier: 'canonical', partial: envelope.kind === 'data' && envelope.errors > 0 } as const;
    if (parsed === null) {
      this.toArmed(noProfile(envelope, streaming, status, () => !read.partial && reader.profileAbsent(body, kind)));
      return;
    }
    const presence = reader.profilePresence(body, kind, this.deps.ownPk ?? null) ?? undefined;
    if (presence?.counts === 'partial' || presence?.counts === 'invalid') {
      // A count pair that does not read is drift: the profile is stored without counts.
      logger.warn('rim.profile-observer: profile counts unreadable, stored without them', { counts: presence.counts });
    }
    const obs = admitOwnCounts(parsed, read, this.deps.ownPk);
    this.deps.store.observe(obs);
    const listeners = this.waiting.get(obs.fields.username?.toLowerCase() ?? '');
    if (listeners === undefined) return;
    // A partial read's relationship flags are withheld: positive facts flow, destructive ones wait.
    const viewer = read.partial ? { following: null, requested: null, followsUs: null, incomingRequest: null }
      : reader.profileViewer(body, kind);
    const seen: ProfileSeen = { obs, viewer, presence, ...read };
    for (const listener of [...listeners]) listener({ kind: 'seen', seen });
  }
}
