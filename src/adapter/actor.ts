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
import { ActionAbortedError, ActionBlockedError, AdapterStaleError } from '@/adapter/errors';
import { SURFACE } from '@/adapter/ig-surface';
import type {
  LocateActionResult,
  LocateConfirmRequestResult,
  LocateRectResult,
  LocateScrollResult,
  LocatedRect,
} from '@/adapter/ig-surface';
import {
  type ActivityReporter,
  NOOP_ACTIVITY_REPORTER,
} from '@/adapter/activity-reporter';
import { sleep } from '@/timing/primitives';
import { ADAPTER } from '@/timing/config';

/**
 * Minimal structural view of the tab the Actor drives. `InstagramTab` (from
 * `tab.ts`) satisfies this; tests supply a fake with the same shape.
 */
export interface AdapterTab {
  goto(url: string): Promise<void>;
  evaluate<T>(fnOrString: string | (() => T | Promise<T>)): Promise<T>;
  currentUrl(): string;
}

/**
 * The input port the Actor drives when one is wired (`src/interaction/`
 * `Interactor` satisfies this structurally). When present, element LOCATING
 * still happens in-page (the surface's locate scripts return bounding rects)
 * but every click/scroll is performed through native input events;
 * when absent, behavior is unchanged (the in-page JS click scripts).
 */
export interface ActorInteractor {
  click(target: LocatedRect): Promise<void>;
  /**
   * Scroll `container` by `deltaPx`. `restPoint` (optional) is a hover-safe spot
   * inside the container the cursor rests on while wheeling, so the burst never
   * lands on a username/avatar that would open a hover card and eat the wheel.
   */
  scroll(container: LocatedRect, deltaPx: number, restPoint?: { x: number; y: number }): Promise<void>;
}

/** Tuning for the (real-browser) wait loops. Tests override with tiny values. */
export interface ActorOptions {
  /** Poll interval while waiting for the dialog / confirm control. */
  pollIntervalMs?: number;
  /** Total time to wait before declaring a control absent. */
  pollTimeoutMs?: number;
  /** Optional input engine (see {@link ActorInteractor}). */
  interactor?: ActorInteractor;
  /**
   * Provider of the ACTIVE driver's abort signal (the engine/prune run token),
   * polled per wait iteration — a `stop()` interrupts an in-flight DOM poll
   * instead of sitting out its timeout. Absent → the old always-complete waits.
   */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
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

export class Actor {
  private readonly tab: AdapterTab;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly interactor?: ActorInteractor;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;

  constructor(tab: AdapterTab, opts: ActorOptions = {}) {
    this.tab = tab;
    this.pollIntervalMs = opts.pollIntervalMs ?? ADAPTER.POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? ADAPTER.POLL_TIMEOUT_MS;
    this.interactor = opts.interactor;
    this.abortSignal = opts.abortSignal;
    this.reporter = opts.reporter ?? NOOP_ACTIVITY_REPORTER;
  }

  /**
   * Follow a user. Navigates to the profile, reads the header action button's
   * state by text, and clicks when it says Follow / Follow Back. Idempotent:
   * an already-Following / Requested state resolves ok without re-clicking —
   * reported as `clicked: false` so callers can reconcile the external follow.
   * Throws {@link AdapterStaleError} when the header button is absent.
   */
  async follow(username: string): Promise<Result<{ clicked: boolean }>> {
    this.reporter.report({ kind: 'page', label: `Following @${username}` });
    try {
      return await this.followInner(username);
    } finally {
      this.reporter.clear();
    }
  }

  private async followInner(username: string): Promise<Result<{ clicked: boolean }>> {
    await this.tab.goto(SURFACE.profileUrl(username));
    // A1: the SPA is still hydrating when `goto` resolves — the action button is
    // not guaranteed to be in the DOM on the first probe. Retry the initial
    // lookup through `waitFor` until the control appears or the timeout elapses.
    const res = await this.waitFor<FindButtonResult>(
      'actor.follow',
      () => this.findAndAct('follow'),
      (r) => Boolean(r?.found),
    );

    if (!res?.found) {
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
        // A block interstitial (not drift, not a lost click) is why a verified
        // click can fail to change state — surface it as a BLOCK so the record
        // is left untouched instead of burning retries.
        await this.throwIfBlocked('actor.follow');
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
    this.reporter.report({ kind: 'page', label: `Unfollowing @${username}` });
    try {
      return await this.unfollowInner(username);
    } finally {
      this.reporter.clear();
    }
  }

  private async unfollowInner(username: string): Promise<Result<{ clicked: boolean }>> {
    await this.tab.goto(SURFACE.profileUrl(username));
    // A1: retry the initial lookup through `waitFor` — hydration may not have
    // placed the action button in the DOM when `goto` resolves.
    const res = await this.waitFor<FindButtonResult>(
      'actor.unfollow',
      () => this.findAndAct('unfollow'),
      (r) => Boolean(r?.found),
    );

    if (!res?.found) {
      throw new AdapterStaleError('actor.unfollow', SURFACE.staleSelectorLabel('action-button'));
    }

    if (res.needsConfirm) {
      const confirmed = await this.waitFor<ConfirmResult>(
        'actor.unfollow',
        () => this.confirmUnfollow(),
        (r) => Boolean(r?.confirmed),
      );
      if (!confirmed) {
        // Before declaring drift, LOOK at what is actually on screen: when
        // Instagram throttles the action it replaces the unfollow menu with a
        // block interstitial ("Try Again Later", …) — that is a BLOCK, not a
        // code problem, and must surface as one (observed live 2026-08-15:
        // every second unfollow of a prune run). Anything else on screen is
        // included in the log so the failure is diagnosable, then escalated.
        await this.throwIfBlocked('actor.unfollow');
        // A missing confirm after clicking a VERIFIED 'Following' button is
        // selector drift — loud. But cancelling a pending REQUEST may confirm
        // inline (no dialog observed live for that flow): fall through and let
        // the post-state verification below be the arbiter.
        if (res.state !== 'requested') {
          throw new AdapterStaleError(
            'actor.unfollow',
            SURFACE.staleSelectorLabel('unfollow-confirm'),
          );
        }
        logger.warn('actor.unfollow: no confirm control after cancelling a request; verifying state');
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
        await this.throwIfBlocked('actor.unfollow');
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
    await this.openListDialog('followers', targetUsername);
  }

  /**
   * Open a target's FOLLOWING dialog: click the following stat and wait for
   * the modal to appear. Mirrors {@link openFollowersDialog}; throws
   * {@link AdapterStaleError} if the control is absent or the dialog never
   * appears.
   */
  async openFollowingDialog(targetUsername: string): Promise<void> {
    await this.openListDialog('following', targetUsername);
  }

  /**
   * The shared open-list-dialog body. The stat control opens the modal via JS
   * (verified live), so it is located by TEXT and clicked; `waitFor` retries
   * the locate through SPA hydration.
   *
   * The whole attempt (navigate → click → await modal) runs up to twice: the
   * interactor click dispatches input events at a located rect and reports success
   * without knowing whether the SPA registered it — a rect gone stale during
   * hydration, or a leftover modal swallowing the click, otherwise turns into
   * a false "dialog never appeared" failure. The retry re-navigates first,
   * which reloads the page and clears any stale modal state.
   */
  private async openListDialog(
    which: 'followers' | 'following',
    targetUsername: string,
  ): Promise<void> {
    const op = which === 'followers' ? 'actor.openFollowersDialog' : 'actor.openFollowingDialog';
    const statLabel = which === 'followers' ? 'followers-stat' : 'following-stat';
    this.reporter.report({
      kind: 'page',
      label: `Opening ${which} list · @${targetUsername}`,
    });

    let lastMissing: 'dialog' | typeof statLabel = 'dialog';
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.tab.goto(SURFACE.profileUrl(targetUsername));

      const clicked = await this.waitFor<ClickResult>(
        op,
        () => this.clickStat(which),
        (r) => Boolean(r?.clicked),
      );
      if (!clicked?.clicked) {
        // The stat control never located: retry the whole attempt (navigate →
        // click → await modal) before declaring the selector stale — a slow
        // hydration otherwise consumes both attempts' worth of budget on the
        // first navigate.
        lastMissing = statLabel;
        logger.warn(`${op}: ${statLabel} not located, retrying attempt`, {
          targetUsername,
          attempt,
        });
        continue;
      }
      lastMissing = 'dialog';

      const present = await this.waitFor<DialogResult>(
        op,
        () => this.tab.evaluate<DialogResult>(SURFACE.dialogPresentScript()),
        (r) => Boolean(r?.present),
      );
      if (present) {
        logger.info(op, { targetUsername, attempt });
        return;
      }
      logger.warn(`${op}: dialog did not appear after click, retrying`, {
        targetUsername,
        attempt,
      });
    }
    throw new AdapterStaleError(op, SURFACE.staleSelectorLabel(lastMissing));
  }

  /**
   * Click the nav profile-avatar link — the landing move that rests the tab on
   * the user's OWN profile (the app's default page). Interactor path when possible:
   * the locate script returns the link's rect and the Interactor moves the
   * cursor there and presses with native input events (the SPA can
   * ignore a synthetic in-page `a.click()`). Falls back to the JS click when
   * no interactor/locate script is wired. Returns whether a click happened —
   * the caller confirms the navigation by watching the URL.
   */
  async clickOwnProfileLink(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateProfileLinkScript;
    if (interactor && locate) {
      const res = await this.tab.evaluate<LocateRectResult>(locate());
      if (!res?.found || !Actor.rectUsable(res.rect)) return false;
      await interactor.click(res.rect);
      return true;
    }
    return this.tab.evaluate<boolean>(SURFACE.clickProfileLinkScript());
  }

  /**
   * Click the nav NOTIFICATIONS control — opening (or, when already open,
   * closing: the control toggles) the activity drawer. Opening it fires the
   * news-inbox fetch the follow-back watcher's notifications source observes.
   * Returns whether a click happened; the CALLER verifies the outcome by the
   * response's arrival, not by DOM state. `false` when the control cannot be
   * located or no interactor is wired — the caller warns and skips (a later
   * check retries); it is not escalated to stale because the nav rail is
   * legitimately absent on some layouts (e.g. an interstitial).
   */
  async clickNotifications(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateNotificationsLinkScript;
    if (!interactor || !locate) return false;
    const res = await this.waitFor<LocateRectResult>(
      'actor.clickNotifications',
      () => this.tab.evaluate<LocateRectResult>(locate()),
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    if (!res?.found || !Actor.rectUsable(res.rect)) return false;
    await interactor.click(res.rect);
    return true;
  }

  /**
   * Click the "Follows" category filter inside the OPEN notifications drawer,
   * narrowing the feed to follow events. Soft-optional: `false` (no click)
   * when the drawer has no filter chips — the JSON parse filters by story
   * type anyway, so this is a UI-consistency nicety, never load-bearing.
   */
  async clickNotificationsFollowsFilter(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateNotificationsFollowsFilterScript;
    if (!interactor || !locate) return false;
    const res = await this.tab.evaluate<LocateRectResult>(locate());
    if (!res?.found || !Actor.rectUsable(res.rect)) return false;
    await interactor.click(res.rect);
    return true;
  }

  /**
   * Close the notifications drawer via its X control — the drawer's own way out, so
   * the tab is genuinely neutral for whatever acts next. `false` when no
   * close control is found (the caller falls back to toggling the bell).
   */
  async clickNotificationsClose(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateNotificationsCloseScript;
    if (!interactor || !locate) return false;
    const res = await this.tab.evaluate<LocateRectResult>(locate());
    if (!res?.found || !Actor.rectUsable(res.rect)) return false;
    await interactor.click(res.rect);
    return true;
  }

  /**
   * One wheel-scroll round of the notifications drawer's list (loads older
   * notification pages). `false` when nothing scrollable remains — the list
   * fits, is already bottomed, or the drawer is gone.
   */
  async scrollNotificationsList(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateNotificationsScrollScript;
    if (!interactor || !locate) return false;
    const res = await this.tab.evaluate<LocateScrollResult>(locate());
    if (!res?.found || !Actor.rectUsable(res.rect)) return false;
    const scrollTop = res.scrollTop ?? 0;
    const scrollHeight = res.scrollHeight ?? 0;
    const clientHeight = res.clientHeight ?? 0;
    const remaining = Math.max(0, scrollHeight - scrollTop - clientHeight);
    if (remaining <= 0) return false;
    await interactor.scroll(res.rect, Math.min(remaining, Math.max(600, clientHeight * 2)));
    return true;
  }

  /**
   * Click the "Follow requests" entry inside the OPEN notifications drawer —
   * opening the pending-requests panel (which fires the friendships/pending
   * fetch the caller observes). `false` when the entry is absent (public
   * account / nothing pending / drift) — a soft skip, never stale.
   */
  async clickFollowRequestsEntry(): Promise<boolean> {
    const interactor = this.interactor;
    const locate = SURFACE.locateFollowRequestsEntryScript;
    if (!interactor || !locate) return false;
    const res = await this.waitFor<LocateRectResult>(
      'actor.clickFollowRequestsEntry',
      () => this.tab.evaluate<LocateRectResult>(locate()),
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    if (!res?.found || !Actor.rectUsable(res.rect)) return false;
    await interactor.click(res.rect);
    return true;
  }

  /**
   * Accept the FIRST pending follow request in the open requests panel: locate
   * its Confirm control (retrying through hydration), click it, and report WHO
   * was accepted plus how many Confirm controls the panel showed at click
   * time. `clicked: false` when none remain (or the panel/drift) — the caller
   * verifies progress across successive calls via username/remaining.
   */
  async confirmNextFollowRequest(): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }> {
    const interactor = this.interactor;
    const locate = SURFACE.locateConfirmFollowRequestScript;
    if (!interactor || !locate) return { clicked: false, username: null, remaining: 0 };
    const res = await this.waitFor<LocateConfirmRequestResult>(
      'actor.confirmNextFollowRequest',
      () => this.tab.evaluate<LocateConfirmRequestResult>(locate()),
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    if (!res?.found || !Actor.rectUsable(res.rect)) {
      return { clicked: false, username: null, remaining: 0 };
    }
    await interactor.click(res.rect);
    return {
      clicked: true,
      username: res.username ?? null,
      remaining: res.remaining ?? 1,
    };
  }

  /**
   * Scroll the followers dialog to its bottom to trigger the next paginated
   * followers request. The version module's script locates the scroll
   * container (largest scrollable descendant of the dialog).
   */
  async scrollFollowers(): Promise<boolean> {
    // Interactor path: locate the container in-page, wheel-scroll it with native
    // input events (falls back to the JS jump when either is absent).
    const interactor = this.interactor;
    const locateScroll = SURFACE.locateScrollContainerScript;
    if (interactor && locateScroll) {
      return this.scrollFollowersDriven(interactor, locateScroll);
    }
    // Best-effort: a small follower list that fits in the modal has NO scrollable
    // container (nothing overflows), and the list may not be hydrated on the first
    // attempt. Either way there is simply nothing to scroll — return `false`, do
    // NOT throw. Throwing here would abort the whole collect and discard followers
    // that already loaded from the initial page. The collect loop retries across
    // rounds and stops when nothing new arrives.
    const res = await this.tab.evaluate<ScrollResult>(SURFACE.scrollFollowersScript());
    if (!res?.found) {
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

  /**
   * One find-and-act attempt. Interactor path: the surface's LOCATE script does
   * the same search/decision as `findAndActScript` but returns the button's
   * rect without clicking; the click is then performed with native input
   * events. Fallback (no interactor, or a surface version without locate
   * scripts): the unchanged in-page JS click script.
   */
  private async findAndAct(op: 'follow' | 'unfollow'): Promise<FindButtonResult> {
    const interactor = this.interactor;
    const locate = SURFACE.locateActionButtonScript;
    if (interactor && locate) {
      const res = await this.tab.evaluate<LocateActionResult>(locate(op));
      if (!res?.found) return { found: false };
      // A would-click button with an unpressable rect (hidden/off-screen) is
      // treated as not-found so the wait loop retries through hydration — never
      // pressed at a garbage point and "verified" as a success.
      if (res.wouldClick && !Actor.rectUsable(res.rect)) return { found: false };
      const clicked = Boolean(res.wouldClick && res.rect);
      if (clicked && res.rect) await interactor.click(res.rect);
      return {
        found: true,
        state: res.state ?? 'unknown',
        clicked,
        needsConfirm: clicked && Boolean(res.needsConfirm),
      };
    }
    return this.tab.evaluate<FindButtonResult>(SURFACE.findAndActScript(op));
  }

  /** One unfollow-confirm attempt (via the interactor when possible; JS click fallback). */
  private async confirmUnfollow(): Promise<ConfirmResult> {
    const interactor = this.interactor;
    const locate = SURFACE.locateConfirmUnfollowScript;
    if (interactor && locate) {
      const res = await this.tab.evaluate<LocateRectResult>(locate());
      if (!res?.found || !Actor.rectUsable(res.rect)) return { confirmed: false };
      await interactor.click(res.rect);
      return { confirmed: true };
    }
    return this.tab.evaluate<ConfirmResult>(SURFACE.confirmUnfollowScript());
  }

  /** One stat-control click attempt (via the interactor when possible; JS click fallback). */
  private async clickStat(which: 'followers' | 'following'): Promise<ClickResult> {
    const interactor = this.interactor;
    const locate =
      which === 'followers'
        ? SURFACE.locateFollowersStatScript
        : SURFACE.locateFollowingStatScript;
    if (interactor && locate) {
      const res = await this.tab.evaluate<LocateRectResult>(locate());
      if (!res?.found || !Actor.rectUsable(res.rect)) return { clicked: false };
      await interactor.click(res.rect);
      return { clicked: true };
    }
    const script =
      which === 'followers'
        ? SURFACE.clickFollowersStatScript()
        : SURFACE.clickFollowingStatScript();
    return this.tab.evaluate<ClickResult>(script);
  }

  /**
   * One interactor dialog-scroll round: locate the scroll container's rect +
   * metrics in-page, then wheel-scroll toward the bottom with real input
   * events. The per-round distance is the remaining scroll, capped at three
   * viewports — a few screens are covered at a time, and the collect loop's
   * rounds carry the walk onward anyway. Returns `false` (nothing to scroll)
   * exactly like the JS path when the container is absent or already bottomed.
   */
  private async scrollFollowersDriven(
    interactor: ActorInteractor,
    locate: () => string,
  ): Promise<boolean> {
    const res = await this.tab.evaluate<LocateScrollResult>(locate());
    if (!res?.found || !Actor.rectUsable(res.rect)) {
      logger.debug('actor.scrollFollowers: no scroll container (list fits or not yet hydrated)');
      return false;
    }
    const scrollTop = res.scrollTop ?? 0;
    const scrollHeight = res.scrollHeight ?? 0;
    const clientHeight = res.clientHeight ?? 0;
    const remaining = Math.max(0, scrollHeight - scrollTop - clientHeight);
    if (remaining <= 0) {
      logger.debug('actor.scrollFollowers: container already at bottom');
      return false;
    }
    const delta = Math.min(remaining, Math.max(600, clientHeight * 3));
    // Rest the cursor on the hover-safe point the locate script found (off the
    // username/avatar/button hover triggers) so the wheel scrolls the list and
    // not an Instagram hover-preview card. Absent → the Interactor picks its own
    // interior entry point.
    await interactor.scroll(res.rect, delta, res.safePoint);
    logger.debug('actor.scrollFollowers (interactor)', {
      scrollTop,
      scrollHeight,
      delta,
      safePoint: res.safePoint ?? null,
    });
    return true;
  }

  /**
   * Poll `run` until `done` is satisfied, the timeout elapses, or the ACTIVE
   * driver's abort signal fires (a `stop()` must not sit out an 8s poll).
   *
   * An abort THROWS {@link ActionAbortedError} instead of resolving `null`:
   * `null` is the "control absent" shape callers escalate to
   * `AdapterStaleError` — burning a retry and a failed ledger row — and a user
   * pressing Stop is neither selector drift nor a failure. Without a signal
   * the old behavior holds: always at least one attempt, even with a
   * zero/negative timeout.
   */
  private async waitFor<T>(
    op: string,
    run: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T | null> {
    const signal = this.abortSignal?.();
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw new ActionAbortedError(op);
      const value = await run();
      if (done(value)) return value;
      if (Date.now() >= deadline) return null;
      if (signal?.aborted) throw new ActionAbortedError(op);
      await sleep(this.pollIntervalMs, signal);
    }
  }

  /**
   * Whether a located rect is actually pressable: non-degenerate (a
   * `display:none` element reports 0×0 — its text still matches, but pressing
   * its rect would fire native input at viewport (0,0)) and with its center
   * inside the viewport's positive quadrant. A failed guard is treated as
   * "control not found" so the wait loops retry through hydration instead of
   * clicking an arbitrary screen point and reporting success.
   */
  private static rectUsable(rect: LocatedRect | undefined): rect is LocatedRect {
    if (!rect) return false;
    if (!(rect.width >= 2 && rect.height >= 2)) return false;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return cx > 0 && cy > 0;
  }

  /**
   * Look at what is ACTUALLY on screen when an expected control is missing or
   * a click failed to change state: read the dialog/alert text (the same probe
   * the Sentinel uses) and, if it matches a block signature, throw
   * {@link ActionBlockedError} — Instagram throttled the action; the caller
   * leaves the record/candidate untouched and backs off. Any other on-screen
   * text is warn-logged (truncated) so the eventual stale/failed escalation is
   * diagnosable instead of blind. Probe failures are swallowed into the
   * original escalation path — this must never mask the real error.
   */
  private async throwIfBlocked(op: string): Promise<void> {
    let text = '';
    try {
      const probed = await this.tab.evaluate<unknown>(SURFACE.bodyTextProbeScript());
      if (typeof probed === 'string') text = probed;
    } catch (e) {
      logger.debug('actor.blockProbe: body-text probe failed', { op, error: String(e) });
      return;
    }
    if (text.trim() === '') return;
    for (const sig of SURFACE.textSignatures) {
      if (sig.pattern.test(text)) {
        logger.warn('actor: block interstitial detected in place of expected control', {
          op,
          matched: String(sig.pattern),
        });
        throw new ActionBlockedError(op, String(sig.pattern));
      }
    }
    logger.warn('actor: expected control missing; on-screen dialog text follows', {
      op,
      textHead: text.slice(0, 200),
    });
  }

  /**
   * A3: poll the profile action button's leading state (via the same primary →
   * fallback anchor search) until `accept(state)` holds or the timeout elapses.
   * Returns `true` only when the expected post-state is observed.
   */
  private async verifyPostState(accept: (state: ButtonState) => boolean): Promise<boolean> {
    const probe = await this.waitFor<ProbeStateResult>(
      'actor.verifyPostState',
      () => this.tab.evaluate<ProbeStateResult>(SURFACE.probeStateScript()),
      (r) => Boolean(r?.found && accept(r.state)),
    );
    return Boolean(probe?.found && accept(probe.state));
  }
}
