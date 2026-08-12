/**
 * Actor — the ONLY DOM-touching code in Peanut.
 *
 * Everything else in the adapter reads Instagram through the JSON/GraphQL data
 * layer (structure-stable). The Actor is the single place that clicks buttons
 * and scrolls the followers dialog. Because Instagram's class names are
 * obfuscated and rotate (`_aswp _aswr …`), the Actor NEVER selects by class:
 * the profile action button is found by matching its LEADING text against the
 * verified regexes in `field-notes.ts` (`Follow` / `Following` / `Requested` /
 * `Follow Back`). The button's `textContent` may carry trailing icon alt-text
 * (observed: "FollowingDown chevron icon"), so we match the leading word only.
 *
 * Every operation runs a health-check: if the header button / dialog / scroll
 * container it needs is absent, it throws `AdapterStaleError` so selector drift
 * fails loud instead of silently reporting success.
 */

import * as logger from '@/utils/logger';
import { ok, err, type Result } from '@/utils/result';
import { AdapterStaleError } from '@/adapter/errors';
import { IG_ORIGIN, SELECTORS, SCROLL_CONTAINER_HEURISTIC } from '@/adapter/field-notes';

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

/** A RegExp serialized for reconstruction inside the page context. */
interface RegexLiteral {
  source: string;
  flags: string;
}

const regexLiteral = (r: RegExp): RegexLiteral => ({ source: r.source, flags: r.flags });

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
   * an already-Following / Requested state resolves ok without re-clicking.
   * Throws {@link AdapterStaleError} when the header button is absent.
   */
  async follow(username: string): Promise<Result<void>> {
    await this.tab.goto(this.profileUrl(username));
    // A1: the SPA is still hydrating when `goto` resolves — the action button is
    // not guaranteed to be in the DOM on the first probe. Retry the initial
    // lookup through `waitFor` until the control appears or the timeout elapses.
    const res = await this.waitFor<FindButtonResult>(
      () => this.tab.evaluate<FindButtonResult>(this.findAndActScript('follow')),
      (r) => Boolean(r && r.found),
    );

    if (!res || !res.found) {
      throw new AdapterStaleError('actor.follow', SELECTORS.profileActionButtonRole);
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
    }
    return ok(undefined);
  }

  /**
   * Unfollow a user. Navigates to the profile, and when the button reads
   * Following, clicks it to open the confirm menu, then clicks the control
   * whose text matches `unfollowConfirmText`. Idempotent: an already-Follow
   * state resolves ok. Throws {@link AdapterStaleError} when the header button
   * is absent, or when the confirm control never appears after opening the menu.
   */
  async unfollow(username: string): Promise<Result<void>> {
    await this.tab.goto(this.profileUrl(username));
    // A1: retry the initial lookup through `waitFor` — hydration may not have
    // placed the action button in the DOM when `goto` resolves.
    const res = await this.waitFor<FindButtonResult>(
      () => this.tab.evaluate<FindButtonResult>(this.findAndActScript('unfollow')),
      (r) => Boolean(r && r.found),
    );

    if (!res || !res.found) {
      throw new AdapterStaleError('actor.unfollow', SELECTORS.profileActionButtonRole);
    }

    if (res.needsConfirm) {
      const confirmed = await this.waitFor<ConfirmResult>(
        () => this.tab.evaluate<ConfirmResult>(this.confirmUnfollowScript()),
        (r) => Boolean(r && r.confirmed),
      );
      if (!confirmed) {
        throw new AdapterStaleError('actor.unfollow', String(SELECTORS.unfollowConfirmText));
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
    }
    return ok(undefined);
  }

  /**
   * Open a target's followers dialog: click the followers link and wait for the
   * modal to appear. Throws {@link AdapterStaleError} if the link is absent or
   * the dialog never appears.
   */
  async openFollowersDialog(targetUsername: string): Promise<void> {
    await this.tab.goto(this.profileUrl(targetUsername));

    // The followers stat is an a[href="#"] that opens the modal via JS (verified
    // live 2026-08-12), so locate it by TEXT and click. Retry through `waitFor`
    // for SPA hydration.
    const clicked = await this.waitFor<ClickResult>(
      () => this.tab.evaluate<ClickResult>(this.clickFollowersLinkScript(targetUsername)),
      (r) => Boolean(r && r.clicked),
    );
    if (!clicked || !clicked.clicked) {
      throw new AdapterStaleError(
        'actor.openFollowersDialog',
        String(SELECTORS.followersStatText),
      );
    }

    const present = await this.waitFor<DialogResult>(
      () => this.tab.evaluate<DialogResult>(this.dialogPresentScript()),
      (r) => Boolean(r && r.present),
    );
    if (!present) {
      throw new AdapterStaleError('actor.openFollowersDialog', SELECTORS.dialog);
    }
    logger.info('actor.openFollowersDialog', { targetUsername });
  }

  /**
   * Scroll the followers dialog to its bottom to trigger the next paginated
   * `followers/` request. Locates the scroll container by the field-notes
   * heuristic (largest scrollable descendant of the dialog). Throws
   * {@link AdapterStaleError} if no scroll container is found.
   */
  async scrollFollowers(): Promise<void> {
    const res = await this.tab.evaluate<ScrollResult>(this.scrollFollowersScript());
    if (!res || !res.found) {
      throw new AdapterStaleError('actor.scrollFollowers', SCROLL_CONTAINER_HEURISTIC);
    }
    logger.debug('actor.scrollFollowers', {
      scrollHeight: res.scrollHeight,
      scrollTop: res.scrollTop,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private profileUrl(username: string): string {
    return `${IG_ORIGIN}/${username}/`;
  }

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
   * Build the in-page script that locates the profile action button by leading
   * text (NEVER by class) and, for `follow`, clicks when it reads Follow /
   * Follow Back. For `unfollow`, clicks when it reads Following and signals that
   * a confirm click is required. Order of tests matters: `Follow Back` and
   * `Following` are checked before the bare `Follow` regex which would also
   * match their leading word.
   */
  private findAndActScript(op: 'follow' | 'unfollow'): string {
    const selector = SELECTORS.profileActionButtonRole;
    const fallbackSelector = SELECTORS.profileActionButtonRoleFallback;
    const regexes = {
      followBack: regexLiteral(SELECTORS.followBackText),
      following: regexLiteral(SELECTORS.followingText),
      requested: regexLiteral(SELECTORS.requestedText),
      follow: regexLiteral(SELECTORS.followText),
    };
    // A2: search the verified primary anchor first; only if it yields no
    // state-text match, fall back to the broader selector and take the FIRST
    // state-matching button in document order. Never matched by class.
    return `(() => {
  const SEL = ${JSON.stringify(selector)};
  const SEL2 = ${JSON.stringify(fallbackSelector)};
  const RX = ${JSON.stringify(regexes)};
  const OP = ${JSON.stringify(op)};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const search = (sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      const t = norm(n.textContent);
      if (!t) continue;
      if (followBack.test(t)) return { btn: n, state: 'follow-back' };
      if (following.test(t)) return { btn: n, state: 'following' };
      if (requested.test(t)) return { btn: n, state: 'requested' };
      if (follow.test(t)) return { btn: n, state: 'follow' };
    }
    return null;
  };
  let hit = search(SEL);
  if (!hit) hit = search(SEL2);
  if (!hit) return { found: false };
  const btn = hit.btn;
  const state = hit.state;
  let clicked = false;
  let needsConfirm = false;
  if (OP === 'follow') {
    if (state === 'follow' || state === 'follow-back') { btn.click(); clicked = true; }
  } else {
    if (state === 'following') { btn.click(); clicked = true; needsConfirm = true; }
    else if (state === 'requested') { btn.click(); clicked = true; }
  }
  return { found: true, state: state, clicked: clicked, needsConfirm: needsConfirm };
})()`;
  }

  /**
   * A3: poll the profile action button's leading state (via the same primary →
   * fallback anchor search) until `accept(state)` holds or the timeout elapses.
   * Returns `true` only when the expected post-state is observed.
   */
  private async verifyPostState(accept: (state: ButtonState) => boolean): Promise<boolean> {
    const probe = await this.waitFor<ProbeStateResult>(
      () => this.tab.evaluate<ProbeStateResult>(this.readButtonStateScript()),
      (r) => Boolean(r && r.found && accept(r.state)),
    );
    return Boolean(probe && probe.found && accept(probe.state));
  }

  /**
   * In-page probe: read the profile action button's current leading state,
   * searching the primary anchor first then the fallback (never by class). Used
   * by A3's post-click verification.
   */
  private readButtonStateScript(): string {
    const selector = SELECTORS.profileActionButtonRole;
    const fallbackSelector = SELECTORS.profileActionButtonRoleFallback;
    const regexes = {
      followBack: regexLiteral(SELECTORS.followBackText),
      following: regexLiteral(SELECTORS.followingText),
      requested: regexLiteral(SELECTORS.requestedText),
      follow: regexLiteral(SELECTORS.followText),
    };
    return `(() => { /* actor:probe-state */
  const SEL = ${JSON.stringify(selector)};
  const SEL2 = ${JSON.stringify(fallbackSelector)};
  const RX = ${JSON.stringify(regexes)};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const search = (sel) => {
    const nodes = Array.from(document.querySelectorAll(sel));
    for (const n of nodes) {
      const t = norm(n.textContent);
      if (!t) continue;
      if (followBack.test(t)) return 'follow-back';
      if (following.test(t)) return 'following';
      if (requested.test(t)) return 'requested';
      if (follow.test(t)) return 'follow';
    }
    return null;
  };
  let state = search(SEL);
  if (!state) state = search(SEL2);
  if (!state) return { found: false, state: 'unknown' };
  return { found: true, state: state };
})()`;
  }

  /** In-page script: click the confirm control in the unfollow menu/dialog. */
  private confirmUnfollowScript(): string {
    const rx = regexLiteral(SELECTORS.unfollowConfirmText);
    return `(() => {
  const RX = ${JSON.stringify(rx)};
  const rx = new RegExp(RX.source, RX.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const dialog = document.querySelector('[role="dialog"]');
  const scope = dialog || document;
  const nodes = Array.from(scope.querySelectorAll('button, [role="button"], [role="menuitem"]'));
  for (const n of nodes) {
    if (rx.test(norm(n.textContent))) { n.click(); return { confirmed: true }; }
  }
  return { confirmed: false };
})()`;
  }

  /**
   * In-page script: click the followers-count control that opens the modal.
   *
   * On current Instagram the followers stat is an `<a href="#">` opened via JS
   * (not `/<user>/followers/`), so we locate it by TEXT — the anchor/button whose
   * text names "followers" (and not "following") — searching the profile header
   * first, then main, then the body. We click the nearest clickable ancestor.
   */
  private clickFollowersLinkScript(_target: string): string {
    const followers = regexLiteral(SELECTORS.followersStatText);
    const following = regexLiteral(SELECTORS.followingStatText);
    return `(() => {
  const RXF = ${JSON.stringify(followers)};
  const RXG = ${JSON.stringify(following)};
  const followers = new RegExp(RXF.source, RXF.flags);
  const following = new RegExp(RXG.source, RXG.flags);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const isFollowers = (t) => followers.test(t) && !following.test(t);
  const clickableOf = (el) => el.closest('a, button, [role="button"], [role="link"]') || el;
  const scopes = [document.querySelector('header'), document.querySelector('main'), document.body].filter(Boolean);
  for (const scope of scopes) {
    const cands = scope.querySelectorAll('a, [role="link"], [role="button"], button');
    for (const el of cands) {
      if (isFollowers(norm(el.textContent))) { clickableOf(el).click(); return { clicked: true }; }
    }
  }
  return { clicked: false };
})()`;
  }

  /** In-page script: report whether the followers dialog is present. */
  private dialogPresentScript(): string {
    return `(() => ({ present: !!document.querySelector(${JSON.stringify(SELECTORS.dialog)}) }))()`;
  }

  /**
   * In-page script implementing SCROLL_CONTAINER_HEURISTIC: within the dialog,
   * find the descendant with the greatest scrollHeight whose computed
   * overflow-y is auto|scroll and scrollHeight > clientHeight, then scroll it
   * to the bottom to trigger pagination.
   */
  private scrollFollowersScript(): string {
    return `(() => {
  const dialog = document.querySelector(${JSON.stringify(SELECTORS.dialog)});
  if (!dialog) return { found: false };
  const nodes = Array.from(dialog.querySelectorAll('*'));
  let best = null;
  let bestH = 0;
  for (const el of nodes) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      if (el.scrollHeight > bestH) { bestH = el.scrollHeight; best = el; }
    }
  }
  if (!best) return { found: false };
  best.scrollTop = best.scrollHeight;
  return { found: true, scrollHeight: best.scrollHeight, scrollTop: best.scrollTop };
})()`;
  }
}
