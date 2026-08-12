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
import { ok, type Result } from '@/utils/result';
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
    const res = await this.tab.evaluate<FindButtonResult>(this.findAndActScript('follow'));

    if (!res || !res.found) {
      throw new AdapterStaleError('actor.follow', SELECTORS.profileActionButtonRole);
    }
    logger.info('actor.follow', { username, state: res.state, clicked: res.clicked });
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
    const res = await this.tab.evaluate<FindButtonResult>(this.findAndActScript('unfollow'));

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
    return ok(undefined);
  }

  /**
   * Open a target's followers dialog: click the followers link and wait for the
   * modal to appear. Throws {@link AdapterStaleError} if the link is absent or
   * the dialog never appears.
   */
  async openFollowersDialog(targetUsername: string): Promise<void> {
    await this.tab.goto(this.profileUrl(targetUsername));

    const clicked = await this.tab.evaluate<ClickResult>(
      this.clickFollowersLinkScript(targetUsername),
    );
    if (!clicked || !clicked.clicked) {
      throw new AdapterStaleError(
        'actor.openFollowersDialog',
        SELECTORS.followersLink(targetUsername),
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
    const regexes = {
      followBack: regexLiteral(SELECTORS.followBackText),
      following: regexLiteral(SELECTORS.followingText),
      requested: regexLiteral(SELECTORS.requestedText),
      follow: regexLiteral(SELECTORS.followText),
    };
    return `(() => {
  const SEL = ${JSON.stringify(selector)};
  const RX = ${JSON.stringify(regexes)};
  const OP = ${JSON.stringify(op)};
  const mk = (o) => new RegExp(o.source, o.flags);
  const followBack = mk(RX.followBack);
  const following = mk(RX.following);
  const requested = mk(RX.requested);
  const follow = mk(RX.follow);
  const norm = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const nodes = Array.from(document.querySelectorAll(SEL));
  let btn = null;
  let state = 'unknown';
  for (const n of nodes) {
    const t = norm(n.textContent);
    if (!t) continue;
    if (followBack.test(t)) { btn = n; state = 'follow-back'; break; }
    if (following.test(t)) { btn = n; state = 'following'; break; }
    if (requested.test(t)) { btn = n; state = 'requested'; break; }
    if (follow.test(t)) { btn = n; state = 'follow'; break; }
  }
  if (!btn) return { found: false };
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

  /** In-page script: click the followers link that opens the modal. */
  private clickFollowersLinkScript(target: string): string {
    const selector = SELECTORS.followersLink(target);
    return `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { clicked: false };
  el.click();
  return { clicked: true };
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
