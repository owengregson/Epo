/**
 * MutationWatch — the network-side arbiter of one follow/unfollow click.
 *
 * Now a thin specialisation of the generic {@link ResponseWatch}: arm before
 * the click, recognise the mutation request through the active surface, read
 * the body once it lands, classify the server's verdict. The mechanics
 * (subscribe / first-match-wins / timeout / abort) live in `ResponseWatch` so
 * the drawer and requests panel can arm their own expected responses instead of
 * clicking and hoping.
 *
 * Version-agnostic by construction: request matching, verdict extraction and
 * the refusal signatures all come from `SURFACE`; only the numbers (HTTP status
 * families) are read here, through `classifyMutationResponse`.
 */

import {
  classifyMutationResponse,
  type MutationClassification,
  type MutationKind,
  type MutationVerdict,
  SHAPE_MISMATCH,
  type ShapeMismatch,
  SURFACE,
} from '@/adapter/ig-surface';
import { ResponseWatch } from '@/adapter/response-watch';
import type { MaybeObservable } from '@/adapter/tab-ports';
import { driftConfirmThreshold } from '@/kernel/derive';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';
import { gateObserved } from '@/surface/read/gate';
import { decodeBody } from '@/surface/transport/decode';
import { graphqlEnvelope } from '@/surface/transport/graphql';
import type { TabResponse } from '@/types';
import * as logger from '@/utils/logger';

/** One recognised, classified mutation response. */
export interface MutationObservation {
  kind: MutationKind;
  /** The subject pk when the request URL carried it (GraphQL forms do not). */
  pk: string | null;
  url: string;
  httpStatus: number;
  classification: MutationClassification;
  /** `candidate`: an unrecognised relationship mutation read at the deadline — only ever a wall. */
  via?: 'match' | 'candidate';
}

/** One unmatched POST seen while the watch was armed — diagnosis, not data. */
export interface UnmatchedPost {
  /** URL path only: query strings carry session tokens and never reach a log. */
  path: string;
  friendlyName: string | null;
  status: number;
}


/**
 * BLINDNESS — the watch's verdict on its own table. One unobserved window is a
 * slow response; a STREAK of them means the surface's mutation table matches
 * nothing Instagram fires, and every action has silently degraded to DOM-only
 * verification (a rate wall then costs a breaker's worth of clicks instead of
 * one). That must be an ERROR in the log pane, once per streak, carrying the
 * POSTs the tab did see — the capture the table needs.
 */
/** Unobserved windows in a row that confirm it: a never-matched request is a definitive shape signal. */
export const MUTATION_BLIND_STREAK = driftConfirmThreshold();

export const MUTATION_BLINDNESS = (() => {
  let run = 0;
  return {
    streak: (): number => run,
    reset: (): void => {
      run = 0;
    },
    observed: (): void => {
      run = 0;
    },
    unobserved(op: string, postsSeen: readonly UnmatchedPost[]): void {
      run += 1;
      if (run !== MUTATION_BLIND_STREAK) return;
      logger.error(
        'mutation-watch: the mutation table matches nothing Instagram fires — actions are DOM-verified only and a rate limit cannot be seen; extend the surface mutation table from postsSeen',
        { op, consecutiveUnobserved: run, postsSeen },
      );
    },
  };
})();

/** The slice of a tab a watch needs: the response observer, when the tab has one. */
export type ResponseObservable = MaybeObservable;

export class MutationWatch {
  /** False when the tab exposes no response seam — the watch never observes. */
  readonly available: boolean;
  private readonly watch: ResponseWatch<MutationObservation>;
  private readonly unmatched: UnmatchedPost[] = [];
  /** Unrecognised relationship-family mutation responses (references, read only at the deadline). */
  private readonly candidates: TabResponse[] = [];
  private readonly kind: MutationKind;
  private readonly op: string;

  constructor(kind: MutationKind, op: string, tab: ResponseObservable) {
    this.kind = kind;
    this.op = op;
    this.watch = new ResponseWatch<MutationObservation>(
      {
        op,
        matches: (response) => MutationWatch.matchOf(response)?.kind === kind,
        read: async (response) => MutationWatch.classify(kind, op, response),
        // A body that cannot be read is not a reason to drop the observation:
        // the STATUS alone still classifies, and never as a fabricated verdict.
        onError: (response, error) => {
          logger.warn('mutation-watch: could not read the mutation body', {
            op,
            status: response.status,
            error: String(error),
          });
          return MutationWatch.observation(kind, response, SHAPE_MISMATCH, op);
        },
        onUnmatched: (response) => this.noteUnmatched(response),
      },
      tab,
    );
    this.available = this.watch.available;
  }

  /** Press → response, in ms; `null` when nothing arrived. Feeds `SurfaceMeter`. */
  latencyMs(): number | null {
    return this.watch.latencyMs();
  }

  /** The classified observation if one has arrived, without waiting (the confirm-layer loop, ADR 0308). */
  peek(): MutationObservation | null {
    return this.watch.peek();
  }

  /** Re-base the arrival latency on the press that may fire the mutation (a later confirm layer). */
  markPress(): void {
    this.watch.markPress();
  }

  /**
   * The first matching mutation's classified observation, else — at the deadline — a wall an
   * unrecognised relationship mutation answered with, else `null`. A candidate never confirms a
   * success. Throws `ActionAbortedError` when the driver's abort signal fires mid-wait.
   */
  async next(timeoutMs: number, signal?: AbortSignal): Promise<MutationObservation | null> {
    return (await this.watch.next(timeoutMs, signal)) ?? (await this.candidateWall());
  }

  /** The newest candidate whose status or GraphQL body names a wall, as a `via: 'candidate'` observation. */
  private async candidateWall(): Promise<MutationObservation | null> {
    for (const response of [...this.candidates].reverse()) {
      const wall = await this.wallOf(response);
      if (wall === null) continue;
      logger.warn(`${this.op}: an unrecognised relationship mutation answered with a wall`, {
        friendlyName: SURFACE.friendlyName(response.requestHeaders) ?? null, status: response.status, outcome: wall.kind });
      return { kind: this.kind, pk: null, url: response.url, httpStatus: response.status, classification: wall, via: 'candidate' };
    }
    return null;
  }

  /** The wall one candidate's status or GraphQL body names, or `null` (never a success). */
  private async wallOf(response: TabResponse): Promise<MutationClassification | null> {
    const gate = gateObserved(response.status, response.mimeType, SURFACE.transport.parseableMime);
    if (gate.kind === 'wall') return { kind: gate.family, detail: `HTTP ${response.status}` };
    let text: string;
    try {
      text = await response.getBody();
    } catch (e) {
      logger.debug('mutation-watch: candidate body unavailable', { op: this.op, error: String(e) });
      return null;
    }
    const decoded = decodeBody(text, SURFACE.transport);
    const envelope = decoded.ok ? graphqlEnvelope(decoded.json, () => false, SURFACE.graphql, SURFACE.mutationRefusalSignatures) : null;
    if (envelope?.kind !== 'wall') return null;
    return { kind: envelope.status === 'action-blocked' ? 'rate-limited' : 'auth', wall: envelope.status, detail: envelope.text };
  }

  /**
   * The POSTs seen while armed that the surface did not recognise as this
   * mutation. When `next` times out, THIS is the capture a drifted mutation
   * table needs: the request Instagram really fired is almost always in it.
   */
  unmatchedPosts(): readonly UnmatchedPost[] {
    return this.unmatched;
  }

  /**
   * The window expired with nothing recognised: name the gap, WITH what the tab
   * did see, so one log line is enough to extend the surface's mutation table.
   */
  warnUnobserved(username: string): void {
    logger.warn(`${this.op}: no mutation response observed after the click; verifying by DOM`, {
      username,
      postsSeen: this.unmatched,
    });    MUTATION_BLINDNESS.unobserved(this.op, this.unmatched);
  }

  private noteUnmatched(response: TabResponse): void {
    if (response.method?.toUpperCase() !== 'POST') return;
    let path = response.url;
    try {
      path = new URL(response.url).pathname;
    } catch {
      // Not an absolute URL: keep it, minus anything after the path.
      path = response.url.split(/[?#]/)[0];
    }
    this.unmatched.push({
      path,
      friendlyName: SURFACE.friendlyName(response.requestHeaders) ?? null,
      status: response.status,
    });
    if (this.unmatched.length > SURFACE_BOUNDS.unmatchedPostsKept) this.unmatched.shift();
    if (SURFACE.mutationCandidate({ url: response.url, method: response.method, requestHeaders: response.requestHeaders })) {
      this.candidates.push(response);
      if (this.candidates.length > SURFACE_BOUNDS.unmatchedPostsKept) this.candidates.shift();
    }
  }

  /** Release the tab subscription. Idempotent; safe before and after `next`. */
  dispose(): void {
    this.watch.dispose();
  }

  private static matchOf(response: TabResponse): { kind: MutationKind; pk: string | null } | null {
    return SURFACE.matchMutation({
      url: response.url,
      method: response.method,
      requestHeaders: response.requestHeaders,
    });
  }

  private static async classify(
    kind: MutationKind,
    op: string,
    response: TabResponse,
  ): Promise<MutationObservation> {
    // One decoder for every body: a guarded or streamed mutation body classifies too.
    const decoded = decodeBody(await response.getBody(), SURFACE.transport);
    if (!decoded.ok) {
      // An HTML wall page on a 429 is the expected shape here; the status classifies it.
      logger.debug('mutation-watch: undecodable mutation body', { op, status: response.status, reason: decoded.reason,
        head: decoded.head });
    }
    const verdict = SURFACE.extractMutationVerdict(decoded.ok ? decoded.json : undefined, kind);
    return MutationWatch.observation(kind, response, verdict, op);
  }

  private static observation(
    kind: MutationKind,
    response: TabResponse,
    verdict: MutationVerdict | ShapeMismatch,
    op: string,
  ): MutationObservation {
    const classification = classifyMutationResponse(response.status, verdict);
    MUTATION_BLINDNESS.observed();
    const pk = MutationWatch.matchOf(response)?.pk ?? null;
    logger.info('mutation-watch: mutation response observed', {
      op,
      kind,
      pk,
      status: response.status,
      outcome: classification.kind,
      detail: classification.detail,
    });
    return { kind, pk, url: response.url, httpStatus: response.status, classification, via: 'match' };
  }
}
