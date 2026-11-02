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
 * Outcomes are typed, never thrown (an abort excepted):
 *  - `ok`     — the page's profile body, parsed, with the viewer-side flags;
 *  - `gone`   — the page says the profile is not available (deleted, renamed,
 *               or hidden from us) and its client fetched no profile;
 *  - `walled` — the Sentinel names a session/action wall on the page;
 *  - `unanswered` — the page loaded, nothing above happened within the wait:
 *               drift until proven otherwise;
 *  - `tab`    — the tab could not navigate (retrying cannot revive it).
 */

import { ActionAbortedError, TabUnavailableError, TabUnresponsiveError } from '@/adapter/errors';
import { type LocateRectResult, type SentinelStatus, SURFACE } from '@/adapter/ig-surface';
import type { Navigable } from '@/adapter/tab-ports';
import { MOTION } from '@/kernel/motion-policy';
import type { ProfileExpectation } from '@/rim/profile-observer';
import type { ProfileVisit, ProfileVisitor } from '@/rim/profile-visit-port';
import { ADAPTER } from '@/timing/config';
import { clamp, logNormal } from '@/timing/distributions';
import { type Rng, type SleepFn, sample, sleep } from '@/timing/primitives';

export interface TabProfileVisitorDeps {
  tab: Navigable;
  observer: { expect(username: string): ProfileExpectation };
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
  /** The dwell's sleep, randomness and clock — injected by tests. */
  sleep?: SleepFn;
  rng?: Rng;
  now?: () => number;
}

export class TabProfileVisitor implements ProfileVisitor {
  private readonly waitMs: number;
  private readonly pollMs: number;
  private readonly sleep: SleepFn;
  private readonly rng: Rng;
  private readonly now: () => number;
  /** When the previous visit ENDED — the dwell is measured from here. */
  private lastVisitAt: number | null = null;

  constructor(private readonly deps: TabProfileVisitorDeps) {
    this.waitMs = deps.waitMs ?? ADAPTER.POLL_TIMEOUT_MS;
    this.pollMs = deps.pollMs ?? ADAPTER.POLL_INTERVAL_MS;
    this.sleep = deps.sleep ?? sleep;
    this.rng = deps.rng ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  async visit(username: string): Promise<ProfileVisit> {
    const signal = this.deps.abortSignal?.();
    await this.dwell(signal);
    if (signal?.aborted) throw new ActionAbortedError('profile.visit');
    try {
      return await this.load(username, signal);
    } finally {
      this.lastVisitAt = this.now();
    }
  }

  /**
   * A person looks at a profile before opening the next one: rest a drawn
   * dwell ({@link MOTION.profileDwellMedianMs}) since the previous visit ended.
   * The ONE visitor serves every caller, so their visits share one rhythm — no
   * caller can burst. A visit long after the last waits nothing.
   */
  private async dwell(signal: AbortSignal | undefined): Promise<void> {
    if (this.lastVisitAt === null) return;
    const [min, max] = MOTION.profileDwellMs;
    const draw = sample(clamp(logNormal(MOTION.profileDwellMedianMs, MOTION.profileDwellSigma), min, max), this.rng);
    const left = this.lastVisitAt + draw - this.now();
    if (left > 0) await this.sleep(left, signal);
  }

  private async load(username: string, signal: AbortSignal | undefined): Promise<ProfileVisit> {
    const { tab, observer, sentinel } = this.deps;
    // Armed BEFORE the navigation: the body can land before `goto` resolves.
    const expectation = observer.expect(username);
    try {
      await tab.goto(SURFACE.profileUrl(username));
      const deadline = Date.now() + this.waitMs;
      for (;;) {
        const seen = await expectation.next(this.pollMs, signal);
        if (seen !== null) return { ok: true, ...seen };
        const unavailable = await tab.evaluate<LocateRectResult>(SURFACE.locateProfileUnavailableScript());
        if (unavailable?.found) return { ok: false, kind: 'gone', detail: { username } };
        if (Date.now() >= deadline) break;
      }
      if (signal?.aborted) throw new ActionAbortedError('profile.visit');
      const status = await sentinel.check();
      if (status !== 'ok') return { ok: false, kind: 'walled', detail: { username, status } };
      return { ok: false, kind: 'unanswered', detail: { username, url: tab.currentUrl() } };
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
