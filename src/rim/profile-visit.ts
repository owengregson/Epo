/**
 * ProfileVisitor — read a profile the way a person does: open it.
 *
 * Every REST profile read Epo used to compose has been walled (see
 * `profile-observer.ts`), while the profile PAGE keeps working and its own
 * client fetches everything Epo needs. A visit navigates to `/<username>/` and
 * waits for that body through the {@link ProfileObserver} — which has already
 * written it to the store by the time the visit resolves. Epo composes no
 * request: no `doc_id`, no session tokens, nothing for a release to rotate.
 *
 * Outcomes are typed, never thrown (an abort excepted), and decided by evidence:
 *  - `ok`     — the page's profile body, parsed, with the viewer-side flags;
 *  - `walled` — a wall body answered the visit (`via: 'body'`), or at the
 *               deadline the Sentinel names one on the page (`via: 'page'`);
 *  - `gone`   — Instagram's own empty profile body (`profile-absent`), or the
 *               page's "not available" text with no wall or drifted body
 *               (`page-text`);
 *  - `unanswered` — nothing above within the wait, or a drifted body: drift
 *               until proven otherwise;
 *  - `tab`    — the tab could not navigate (retrying cannot revive it).
 */

import { ActionAbortedError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { type LocateRectResult, type SentinelStatus, SURFACE } from '@/adapter/ig-surface';
import type { Navigable } from '@/adapter/tab-ports';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { createIgActivityClock, type IgActivityClock } from '@/rim/ig-activity-clock';
import type { ProfileExpectation } from '@/rim/profile-observer';
import type { ProfileVisit, ProfileVisitor } from '@/rim/profile-visit-port';
import type { DriftClass } from '@/surface/sink';
import { ADAPTER } from '@/timing/config';
import { type Rng, type SleepFn, sleep } from '@/timing/primitives';
import { launchStream } from '@/utils/entropy';

export interface TabProfileVisitorDeps {
  tab: Navigable;
  /** `recoverArmed` reads a visit's deadline candidates (unrouted reads of the profile family) under its anchor. */
  observer: { expect(username: string, opts?: { readonly pk?: string }): ProfileExpectation; recoverArmed?(): Promise<void> };
  sentinel: { check(): Promise<SentinelStatus> };
  /** The ACTIVE driver's abort signal — a stop ends the wait at once. */
  abortSignal?: () => AbortSignal | undefined;
  /**
   * How long after the page loads to wait for its profile read. The query is
   * the page's own hydration read — the data twin of a header control
   * appearing — so it gets the Actor's control wait and poll by default.
   */
  waitMs?: number;
  pollMs?: number;
  /** The default clock's sleep, randomness and tempo, and the visit's clock — injected by tests. */
  sleep?: SleepFn;
  rng?: Rng;
  now?: () => number;
  tempo?: TempoSource;
  /** The graph's activity clock, shared by every Instagram operation (default: this visitor's own). */
  activity?: IgActivityClock;
}

export class TabProfileVisitor implements ProfileVisitor {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  /**
   * Spaces each visit a drawn `dwell.visit` after the last Instagram operation ENDED. The ONE
   * visitor serves every caller and the clock every operation, so no caller can burst.
   */
  private readonly activity: IgActivityClock;

  constructor(private readonly deps: TabProfileVisitorDeps) {
    this.waitMs = deps.waitMs ?? ADAPTER.POLL_TIMEOUT_MS;
    this.pollMs = deps.pollMs ?? ADAPTER.POLL_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
    this.activity = deps.activity ?? createIgActivityClock({ tempo: tempoOrReference(deps.tempo),
      rng: deps.rng ?? launchStream('rim/profile-visit'), now: this.now, sleep: deps.sleep ?? sleep });
  }

  async visit(username: string, opts: { readonly pk?: string } = {}): Promise<ProfileVisit> {
    const signal = this.deps.abortSignal?.();
    await this.activity.spaceEntry(signal);
    if (signal?.aborted) throw new ActionAbortedError('profile.visit');
    try {
      return await this.load(username, opts, signal);
    } finally {
      this.activity.noteEnd(this.now());
    }
  }

  /**
   * The outcome, by evidence (spec §10.4): a profile body answers `ok`; a wall body walls the visit;
   * Instagram's own empty profile body is `gone`; a drifted body outranks the page's text, which
   * alone is `gone` on page text; at the deadline the page's sentinel, else `unanswered`.
   */
  private async load(username: string, opts: { readonly pk?: string }, signal: AbortSignal | undefined): Promise<ProfileVisit> {
    const { tab, observer, sentinel } = this.deps;
    // Armed BEFORE the navigation: the body can land before `goto` resolves.
    const expectation = observer.expect(username, opts);
    let drift: DriftClass | null = null;
    try {
      await tab.goto(SURFACE.profileUrl(username));
      const deadline = Date.now() + this.waitMs;
      for (;;) {
        const event = await expectation.next(this.pollMs, signal);
        if (event?.kind === 'seen') return { ok: true, ...event.seen };
        if (event?.kind === 'wall') {
          return { ok: false, kind: 'walled', detail: { username, via: 'body', family: event.family, status: event.status } };
        }
        if (event?.kind === 'absent') return { ok: false, kind: 'gone', evidence: 'profile-absent', detail: { username } };
        if (event?.kind === 'drift') drift = event.cls;
        if (event !== null) continue;
        const unavailable = await tab.evaluate<LocateRectResult>(SURFACE.locateProfileUnavailableScript());
        if (unavailable?.found) {
          if (drift !== null) return { ok: false, kind: 'unanswered', detail: { username, drift } };
          return { ok: false, kind: 'gone', evidence: 'page-text', detail: { username } };
        }
        if (Date.now() >= deadline) break;
      }
      if (signal?.aborted) throw new ActionAbortedError('profile.visit');
      // The deadline: a read of the profile family the page made under a name Epo does not route may still answer (C2).
      await observer.recoverArmed?.();
      for (let late = await expectation.next(0, signal); late !== null; late = await expectation.next(0, signal)) {
        if (late.kind === 'seen') return { ok: true, ...late.seen };
      }
      const status = await sentinel.check();
      if (status !== 'ok') return { ok: false, kind: 'walled', detail: { username, via: 'page', status } };
      return { ok: false, kind: 'unanswered', detail: { username, url: tab.currentUrl(), ...(drift === null ? {} : { drift }) } };
    } catch (e) {
      if (e instanceof TabUnavailableError || e instanceof TabUnresponsiveError) {
        return { ok: false, kind: 'tab', detail: { username, error: String(e) } };
      }
      throw e;
    } finally {
      expectation.dispose();
    }
  }
}
