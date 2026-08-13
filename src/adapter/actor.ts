/**
 * Actor — the ONLY DOM-touching code in Epo.
 *
 * Everything else in the adapter reads Instagram through the JSON/GraphQL data
 * layer (structure-stable). The Actor is the single place that clicks buttons
 * and scrolls the followers dialog. It is version-agnostic: every in-page
 * script (which embeds the verified selectors and text matchers) is built by
 * the active `SURFACE` version module, so a DOM change on Instagram's side
 * touches only `src/adapter/versions/*` — never this file.
 *
 * Every operation runs a health-check: if the header button / dialog / scroll
 * container it needs is absent, it throws `AdapterStaleError` so selector drift
 * fails loud instead of silently reporting success.
 */

import * as logger from '@/utils/logger';
import { ok, err, type Result } from '@/utils/result';
import { AdapterStaleError } from '@/adapter/errors';
import { SURFACE } from '@/adapter/ig-surface';

/**
 * Minimal structural view of the tab the Actor drives. `InstagramTab` (from
 * `tab.ts`) satisfies this; tests supply a fake with the same shape.
 */
export interface AdapterTab {
  goto(url: string): Promise<void>;
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  currentUrl(): string;
}

/** Tuning for the (real-browser) wait loops. Tests override with tiny values. */
export interface ActorOptions {
  /** Poll interval while waiting for the dialog / confirm control. */
  pollIntervalMs?: number;
  /** Total time to wait before declaring a control absent. */
  pollTimeoutMs?: number;
}

/** Leading-state of the profile action button, as read from the page. */
type ButtonState = 'follow' | 'follow-back' | 'following' | 'requested' | 'unknown';

interface FindButtonResult {
  found: boolean;
  state?: ButtonState;
  clicked?: boolean;
  needsConfirm?: boolean;
}

interface ClickResult {
  clicked: boolean;
}

/** Result of the post-click state probe (A3). */
interface ProbeStateResult {
  found: boolean;
  state: ButtonState;
}

interface ConfirmResult {
  confirmed: boolean;
}

interface DialogResult {
  present: boolean;
}

interface ScrollResult {
  found: boolean;
  scrollHeight?: number;
  scrollTop?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Actor {
  private readonly tab: AdapterTab;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(tab: AdapterTab, opts: ActorOptions = {}) {
    this.tab = tab;
    this.pollIntervalMs = opts.pollIntervalMs ?? 250;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 8000;
  }

  /**
   * Follow a user. Navigates to the profile, reads the header action button's
   * state by text, and clicks when it says Follow / Follow Back. Idempotent:
   * an already-Following / Requested state resolves ok without re-clicking —
   * reported as `clicked: false` so callers can reconcile the external follow.
   * Throws {@link AdapterStaleError} when the header button is absent.
   */
  async follow(username: string): Promise<Result<{ clicked: boolean }>> {
    await this.tab.goto(SURFACE.profileUrl(username));
    // A1: the SPA is still hydrating when `goto` resolves — the action button is
    // not guaranteed to be in the DOM on the first probe. Retry the initial
    // lookup through `waitFor` until the control appears or the timeout elapses.
    const res = await this.waitFor<FindButtonResult>(
      () => this.tab.evaluate<FindButtonResult>(SURFACE.findAndActScript('follow')),
      (r) => Boolean(r && r.found),
    );

    if (!res || !res.found) {
      throw new AdapterStaleError('actor.follow', SURFACE.staleSelectorLabel('action-button'));
    }
    logger.info('actor.follow', { username, state: res.state, clicked: res.clicked });

    // A3: never report ok on an unverified click. Poll the button until it reads
    // the expected post-state before returning. An already-in-target-state
    // button (no click) is an idempotent no-op and resolves ok immediately.
    if (res.clicked) {
      const verified = await this.verifyPostState(
        (s) => s === 'following' || s === 'requested',
      );
      if (!verified) {
        return err(
          `actor.follow: post-click state not confirmed (expected Following/Requested) for ${username}`,
        );
      }
      return ok({ clicked: true });
    }
    return ok({ clicked: false });
  }

  /**
   * Unfollow a user. Navigates to the profile, and when the button reads
   * Following, clicks it to open the confirm menu, then clicks the control
   * whose text matches the unfollow-confirm matcher. Idempotent: an
   * already-Follow state resolves ok without clicking — reported as
   * `clicked: false` so callers can reconcile the external unfollow. Throws
   * {@link AdapterStaleError} when the header button is absent, or when the
   * confirm control never appears after opening the menu.
   */
  async unfollow(username: string): Promise<Result<{ clicked: boolean }>> {
    await this.tab.goto(SURFACE.profileUrl(username));
    // A1: retry the initial lookup through `waitFor` — hydration may not have
    // placed the action button in the DOM when `goto` resolves.
    const res = await this.waitFor<FindButtonResult>(
      () => this.tab.evaluate<FindButtonResult>(SURFACE.findAndActScript('unfollow')),
      (r) => Boolean(r && r.found),
    );

    if (!res || !res.found) {
      throw new AdapterStaleError('actor.unfollow', SURFACE.staleSelectorLabel('action-button'));
    }

    if (res.needsConfirm) {
      const confirmed = await this.waitFor<ConfirmResult>(
        () => this.tab.evaluate<ConfirmResult>(SURFACE.confirmUnfollowScript()),
        (r) => Boolean(r && r.confirmed),
      );
      if (!confirmed) {
        throw new AdapterStaleError(
          'actor.unfollow',
          SURFACE.staleSelectorLabel('unfollow-confirm'),
        );
      }
    }

    logger.info('actor.unfollow', { username, state: res.state, clicked: res.clicked });

    // A3: after a real (post-confirm) click, verify the button flipped back to
    // Follow / Follow Back before returning ok. An already-Follow button (no
    // click) is an idempotent no-op and resolves ok immediately.
    if (res.clicked) {
      const verified = await this.verifyPostState(
        (s) => s === 'follow' || s === 'follow-back',
      );
      if (!verified) {
        return err(
          `actor.unfollow: post-click state not confirmed (expected Follow/Follow Back) for ${username}`,
        );
      }
      return ok({ clicked: true });
    }
    return ok({ clicked: false });
  }

  /**
   * Open a target's followers dialog: click the followers stat and wait for
   * the modal to appear. Throws {@link AdapterStaleError} if the control is
   * absent or the dialog never appears.
   */
  async openFollowersDialog(targetUsername: string): Promise<void> {
    await this.tab.goto(SURFACE.profileUrl(targetUsername));

    // The followers stat opens the modal via JS (verified live), so it is
    // located by TEXT and clicked. Retry through `waitFor` for SPA hydration.
    const clicked = await this.waitFor<ClickResult>(
      () => this.tab.evaluate<ClickResult>(SURFACE.clickFollowersStatScript()),
      (r) => Boolean(r && r.clicked),
    );
    if (!clicked || !clicked.clicked) {
      throw new AdapterStaleError(
        'actor.openFollowersDialog',
        SURFACE.staleSelectorLabel('followers-stat'),
      );
    }

    const present = await this.waitFor<DialogResult>(
      () => this.tab.evaluate<DialogResult>(SURFACE.dialogPresentScript()),
      (r) => Boolean(r && r.present),
    );
    if (!present) {
      throw new AdapterStaleError(
        'actor.openFollowersDialog',
        SURFACE.staleSelectorLabel('dialog'),
      );
    }
    logger.info('actor.openFollowersDialog', { targetUsername });
  }

  /**
   * Open a target's FOLLOWING dialog: click the following stat and wait for
   * the modal to appear. Mirrors {@link openFollowersDialog}; throws
   * {@link AdapterStaleError} if the control is absent or the dialog never
   * appears.
   */
  async openFollowingDialog(targetUsername: string): Promise<void> {
    await this.tab.goto(SURFACE.profileUrl(targetUsername));

    // The following stat is the followers stat's sibling and opens the modal
    // via JS the same way — located by TEXT, retried for SPA hydration.
    const clicked = await this.waitFor<ClickResult>(
      () => this.tab.evaluate<ClickResult>(SURFACE.clickFollowingStatScript()),
      (r) => Boolean(r && r.clicked),
    );
    if (!clicked || !clicked.clicked) {
      throw new AdapterStaleError(
        'actor.openFollowingDialog',
        SURFACE.staleSelectorLabel('following-stat'),
      );
    }

    const present = await this.waitFor<DialogResult>(
      () => this.tab.evaluate<DialogResult>(SURFACE.dialogPresentScript()),
      (r) => Boolean(r && r.present),
    );
    if (!present) {
      throw new AdapterStaleError(
        'actor.openFollowingDialog',
        SURFACE.staleSelectorLabel('dialog'),
      );
    }
    logger.info('actor.openFollowingDialog', { targetUsername });
  }

  /**
   * Scroll the followers dialog to its bottom to trigger the next paginated
   * followers request. The version module's script locates the scroll
   * container (largest scrollable descendant of the dialog).
   */
  async scrollFollowers(): Promise<boolean> {
    // Best-effort: a small follower list that fits in the modal has NO scrollable
    // container (nothing overflows), and the list may not be hydrated on the first
    // attempt. Either way there is simply nothing to scroll — return `false`, do
    // NOT throw. Throwing here would abort the whole collect and discard followers
    // that already loaded from the initial page. The collect loop retries across
    // rounds and stops when nothing new arrives.
    const res = await this.tab.evaluate<ScrollResult>(SURFACE.scrollFollowersScript());
    if (!res || !res.found) {
      logger.debug('actor.scrollFollowers: no scroll container (list fits or not yet hydrated)');
      return false;
    }
    logger.debug('actor.scrollFollowers', {
      scrollHeight: res.scrollHeight,
      scrollTop: res.scrollTop,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Poll `run` until `done` is satisfied or the timeout elapses. */
  private async waitFor<T>(
    run: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T | null> {
    const deadline = Date.now() + this.pollTimeoutMs;
    // Always attempt at least once, even with a zero/negative timeout.
    for (;;) {
      const value = await run();
      if (done(value)) return value;
      if (Date.now() >= deadline) return null;
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * A3: poll the profile action button's leading state (via the same primary →
   * fallback anchor search) until `accept(state)` holds or the timeout elapses.
   * Returns `true` only when the expected post-state is observed.
   */
  private async verifyPostState(accept: (state: ButtonState) => boolean): Promise<boolean> {
    const probe = await this.waitFor<ProbeStateResult>(
      () => this.tab.evaluate<ProbeStateResult>(SURFACE.probeStateScript()),
      (r) => Boolean(r && r.found && accept(r.state)),
    );
    return Boolean(probe && probe.found && accept(probe.state));
  }
}
