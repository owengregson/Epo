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

import { verdictToResult } from '@/adapter/action-result';
import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import * as listScroll from '@/adapter/actor-scroll';
import { arbitrate } from '@/adapter/arbiter';
import { ActionAbortedError, AdapterStaleError, TabUnresponsiveError } from '@/adapter/errors';
import type { LocateActionResult, LocateConfirmRequestResult, LocatedRect, LocateRectResult } from '@/adapter/ig-surface';
import { SURFACE } from '@/adapter/ig-surface';
import { MutationWatch } from '@/adapter/mutation-watch';
import type { ProbeStateResult } from '@/adapter/page';
import { settleAndPress } from '@/adapter/settle-press';
import { ADAPTER_BOUNDS } from '@/kernel/adapter-bounds';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { SURFACE_METER, type SurfaceMetric } from '@/surface/meter';
import { ADAPTER } from '@/timing/config';
import { sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import { ok, type Result } from '@/utils/result';
import { prepareAction } from './action-admission';
import type { ActorInteractor, ActorOptions, AdapterTab } from './actor-types';
import { type ConfirmFlowOptions, confirmDefaults, confirmLayerBound, type LayerFlow, noteUnobserved, runFlow } from './unfollow-flow';

export type { ActorInteractor, ActorOptions, AdapterTab } from './actor-types';

/** The mutation an Actor operation fires — the Verdict's `op` field. */
const watchKind = (op: string): 'follow' | 'unfollow' =>
  op === 'actor.unfollow' ? 'unfollow' : 'follow';

/** Leading-state of the profile action button, as read from the page. */
type ButtonState = ProbeStateResult['state'];

interface FindButtonResult {
  found: boolean;
  state?: ButtonState;
  clicked?: boolean;
  needsConfirm?: boolean;
}

interface ClickResult {
  clicked: boolean;
}

interface DialogResult {
  present: boolean;
}

export class Actor {
  private readonly tab: AdapterTab;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly mutationTimeoutMs: number;
  private readonly interactor: ActorInteractor;
  private readonly abortSignal?: () => AbortSignal | undefined;
  private readonly reporter: ActivityReporter;
  private readonly prepareProfile?: ActorOptions['prepareProfile'];
  private readonly beforeMutation?: ActorOptions['beforeMutation'];
  private readonly tempo: TempoSource;
  private readonly confirm: Required<ConfirmFlowOptions>;

  constructor(tab: AdapterTab, opts: ActorOptions & ConfirmFlowOptions) {
    this.tab = tab;
    this.prepareProfile = opts.prepareProfile;
    this.beforeMutation = opts.beforeMutation;
    this.pollIntervalMs = opts.pollIntervalMs ?? ADAPTER.POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? ADAPTER.POLL_TIMEOUT_MS;
    this.mutationTimeoutMs = opts.mutationTimeoutMs ?? ADAPTER.MUTATION_RESPONSE_TIMEOUT_MS;
    this.interactor = opts.interactor;
    this.abortSignal = opts.abortSignal;
    this.reporter = opts.reporter ?? NOOP_ACTIVITY_REPORTER;
    this.tempo = tempoOrReference(opts.tempo);
    this.confirm = confirmDefaults(opts);
  }

  /**
   * Follow a user. Navigates to the profile, reads the header action button's
   * state by text, and clicks when it says Follow / Follow Back. Idempotent:
   * an already-Following / Requested state resolves ok without re-clicking —
   * reported as `clicked: false` so callers can reconcile the external follow.
   * Throws {@link AdapterStaleError} when the header button is absent.
   */
  async follow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<Result<{ clicked: boolean }>> {
    this.reporter.report({ kind: 'page', op: { op: 'follow', username } });
    try {
      return await this.followInner(username, expectedPk, onDispatch);
    } finally {
      this.reporter.clear();
    }
  }

  private async followInner(username: string, expectedPk?: string, onDispatch?: () => void): Promise<Result<{ clicked: boolean }>> {
    const dispatch = await prepareAction({ tab: this.tab, abortSignal: this.abortSignal,
      prepareProfile: this.prepareProfile, beforeMutation: this.beforeMutation },
      'follow', username, expectedPk, onDispatch);
    // The network arbiter is armed BEFORE the click: the mutation response
    // can land within the same tick as the optimistic DOM flip.
    const watch = new MutationWatch('follow', 'actor.follow', this.tab);
    try {
      return await this.followDriven(username, watch, dispatch);
    } finally {
      watch.dispose();
    }
  }

  private async followDriven(
    username: string,
    watch: MutationWatch,
    dispatch: () => Promise<void>,
  ): Promise<Result<{ clicked: boolean }>> {
    // The SPA is still hydrating when `goto` resolves, so the action button is
    // not guaranteed to be in the DOM on the first probe — `waitFor` retries
    // the lookup until the control appears or the timeout elapses.
    const res = await this.waitFor<FindButtonResult>(
      'actor.follow',
      () => this.findAndAct('follow', dispatch, watch),
      (r) => Boolean(r?.found),
      // `goto` resolve → first successful control locate: the honest definition
      // of "hydration", and the prior behind POLL_TIMEOUT_MS.
      'hydration',
    );

    if (!res?.found) {
      throw new AdapterStaleError('actor.follow', SURFACE.staleSelectorLabel('action-button'));
    }
    logger.info('actor.follow', { username, state: res.state, clicked: res.clicked });

    // An already-in-target-state button (no click) is an idempotent no-op.
    if (!res.clicked) return ok({ clicked: false });
    // A follow expects no confirm layer: one on screen is noticed, never pressed.
    return this.afterPress(this.flow('actor.follow', username, watch, dispatch, 0), res.state);
  }

  /**
   * Unfollow a user. Navigates to the profile, presses the header when it reads
   * Following / Requested, then each confirm layer until Instagram answers (ADR
   * 0308). Idempotent: an already-Follow state resolves ok without clicking —
   * reported as `clicked: false` so callers can reconcile the external
   * unfollow. Throws {@link AdapterStaleError} when the header button is absent.
   */
  async unfollow(username: string, expectedPk?: string, onDispatch?: () => void): Promise<Result<{ clicked: boolean }>> {
    this.reporter.report({ kind: 'page', op: { op: 'unfollow', username } });
    try {
      return await this.unfollowInner(username, expectedPk, onDispatch);
    } finally {
      this.reporter.clear();
    }
  }

  private async unfollowInner(username: string, expectedPk?: string, onDispatch?: () => void): Promise<Result<{ clicked: boolean }>> {
    const dispatch = await prepareAction({ tab: this.tab, abortSignal: this.abortSignal,
      prepareProfile: this.prepareProfile, beforeMutation: this.beforeMutation },
      'unfollow', username, expectedPk, onDispatch);
    // The network arbiter is armed before any click: the unfollow mutation
    // fires on the CONFIRM click (inline for a cancelled request), and its
    // response can land within the same tick as the optimistic DOM flip.
    const watch = new MutationWatch('unfollow', 'actor.unfollow', this.tab);
    try {
      return await this.unfollowDriven(username, watch, dispatch);
    } finally {
      watch.dispose();
    }
  }

  private async unfollowDriven(
    username: string,
    watch: MutationWatch,
    dispatch: () => Promise<void>,
  ): Promise<Result<{ clicked: boolean }>> {
    // The surface's layer bound is read before any press: a malformed document presses nothing.
    const layers = confirmLayerBound();
    // Retry the initial lookup through `waitFor` — hydration may not have
    // placed the action button in the DOM when `goto` resolves.
    const res = await this.waitFor<FindButtonResult>(
      'actor.unfollow',
      () => this.findAndAct('unfollow', dispatch, watch),
      (r) => Boolean(r?.found),
      'hydration',
    );

    if (!res?.found) {
      throw new AdapterStaleError('actor.unfollow', SURFACE.staleSelectorLabel('action-button'));
    }
    logger.info('actor.unfollow', { username, state: res.state, clicked: res.clicked });
    if (!res.clicked) return ok({ clicked: false });
    return this.afterPress(this.flow('actor.unfollow', username, watch, dispatch, res.needsConfirm ? layers : 0), res.state);
  }

  /**
   * After the header press: the confirm layers, then ONE arbitration (ADR 0304, 0308). The press
   * was dispatched, so a tab stall from here on is post-click — the action may have landed.
   */
  private async afterPress(f: LayerFlow, stateBefore: ButtonState | undefined): Promise<Result<{ clicked: boolean }>> {
    try {
      return await runFlow(f, () => this.decide(f, stateBefore));
    } catch (e) {
      Actor.rethrowMarkedPostClick(e);
    }
  }

  /** One action's confirm flow over this Actor's tab, input, tempo and D4 polls. */
  private flow(op: LayerFlow['op'], username: string, watch: MutationWatch, dispatch: () => Promise<void>,
    maxLayers: number): LayerFlow {
    const settled = op === 'actor.follow'
      ? (state: ButtonState) => state === 'following' || state === 'requested'
      : (state: ButtonState) => state === 'follow' || state === 'follow-back';
    return { op, username, tab: this.tab, interactor: this.interactor, watch, dispatch, settled, maxLayers,
      ...this.confirm, tempo: this.tempo, signal: () => this.abortSignal?.(), usable: Actor.rectUsable,
      waitFor: (run, done) => this.waitFor(op, run, done) };
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
      op: { op: 'open-list', list: which, of: targetUsername },
    });

    let lastMissing: 'dialog' | typeof statLabel = 'dialog';
    for (let attempt = 0; attempt < ADAPTER_BOUNDS.OPEN_LIST_ATTEMPTS; attempt++) {
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
   * the user's OWN profile (the app's default page). The locate script returns
   * the link's rect and the Interactor presses it with native input events (the
   * SPA ignores a synthetic in-page `a.click()` here). Returns whether a click
   * happened — the caller confirms the navigation by watching the URL.
   */
  async clickOwnProfileLink(): Promise<boolean> {
    const locate = (): Promise<LocateRectResult> =>
      this.tab.evaluate<LocateRectResult>(SURFACE.locateProfileLinkScript());
    return (await this.settleAndPress(await locate(), locate)) !== null;
  }

  /**
   * Click the nav NOTIFICATIONS control — opening (or, when already open,
   * closing: the control toggles) the activity drawer. Opening it fires the
   * news-inbox fetch the follow-back watcher's notifications source observes.
   * Returns whether a click happened; the CALLER verifies the outcome by the
   * response's arrival, not by DOM state. `false` when the control cannot be
   * located — the caller warns and skips (a later check retries); it is not
   * escalated to stale because the nav rail is legitimately absent on some
   * layouts (e.g. an interstitial).
   */
  async clickNotifications(): Promise<boolean> {
    const locate = (): Promise<LocateRectResult> =>
      this.tab.evaluate<LocateRectResult>(SURFACE.locateNotificationsLinkScript());
    const res = await this.waitFor<LocateRectResult>(
      'actor.clickNotifications',
      locate,
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    return (await this.settleAndPress(res, locate)) !== null;
  }

  /**
   * Click the "Follows" category filter inside the OPEN notifications drawer,
   * narrowing the feed to follow events. Soft-optional: `false` (no click)
   * when the drawer has no filter chips — the JSON parse filters by story
   * type anyway, so this is a UI-consistency nicety, never load-bearing.
   */
  async clickNotificationsFollowsFilter(): Promise<boolean> {
    const locate = (): Promise<LocateRectResult> =>
      this.tab.evaluate<LocateRectResult>(SURFACE.locateNotificationsFollowsFilterScript());
    return (await this.settleAndPress(await locate(), locate)) !== null;
  }

  /**
   * Close the notifications drawer via its X — pressed at its exposed `aim` (the header
   * covers its lower half since 2026-11), leaving the tab neutral for whatever acts next.
   * `false` when no close control is found (the caller falls back to toggling the bell).
   */
  async clickNotificationsClose(): Promise<boolean> {
    const locate = (): Promise<LocateRectResult> =>
      this.tab.evaluate<LocateRectResult>(SURFACE.locateNotificationsCloseScript());
    return (await this.settleAndPress(await locate(), locate)) !== null;
  }

  /**
   * One wheel-scroll round of the notifications drawer's list (`actor-scroll.ts`);
   * `false` when nothing scrollable remains.
   */
  async scrollNotificationsList(): Promise<boolean> {
    return listScroll.scrollNotificationsList(this.scrollDeps());
  }

  /**
   * Click the "Follow requests" entry inside the OPEN notifications drawer —
   * opening the pending-requests panel (which fires the friendships/pending
   * fetch the caller observes). `false` when the entry is absent (public
   * account / nothing pending / drift) — a soft skip, never stale.
   */
  async clickFollowRequestsEntry(): Promise<boolean> {
    const locate = (): Promise<LocateRectResult> =>
      this.tab.evaluate<LocateRectResult>(SURFACE.locateFollowRequestsEntryScript());
    const res = await this.waitFor<LocateRectResult>(
      'actor.clickFollowRequestsEntry',
      locate,
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    return (await this.settleAndPress(res, locate)) !== null;
  }

  /**
   * Accept the FIRST pending follow request in the open requests panel: locate
   * its Confirm control (retrying through hydration), click it, and report WHO
   * was accepted plus how many Confirm controls the panel showed at click
   * time. `clicked: false` when none remain (or the panel/drift) — the caller
   * verifies progress across successive calls via username/remaining.
   */
  async confirmNextFollowRequest(onDispatch?: (username: string | null) => void | Promise<void>): Promise<{
    clicked: boolean;
    username: string | null;
    remaining: number;
  }> {
    const locate = (): Promise<LocateConfirmRequestResult> =>
      this.tab.evaluate<LocateConfirmRequestResult>(SURFACE.locateConfirmFollowRequestScript());
    const res = await this.waitFor<LocateConfirmRequestResult>(
      'actor.confirmNextFollowRequest',
      locate,
      (r) => Boolean(r?.found && Actor.rectUsable(r.rect)),
    );
    // The row REPORTED is the row PRESSED: the one located after the hover.
    let settledUsername: string | null = null;
    const guarded = {
      hover: (rect: LocatedRect) => this.interactor.hover(rect),
      click: async (rect: LocatedRect) => {
        if (this.abortSignal?.()?.aborted) throw new ActionAbortedError('actor.accept-request');
        await onDispatch?.(settledUsername);
        if (this.abortSignal?.()?.aborted) throw new ActionAbortedError('actor.accept-request');
        await this.interactor.click(rect);
      },
    };
    const pressed = await settleAndPress(guarded, res, async () => {
      const row = await locate();
      settledUsername = row?.username ?? null;
      return row;
    }, Actor.rectUsable);
    if (pressed === null) return { clicked: false, username: null, remaining: 0 };
    return {
      clicked: true,
      username: pressed.username ?? null,
      remaining: pressed.remaining ?? 1,
    };
  }

  /**
   * Read the head of the open follow-requests panel WITHOUT clicking: whether a
   * Confirm control is present, whose row it belongs to, and how many remain.
   * The caller compares two probes across an accept to verify the click
   * actually consumed a row. `found: false` when the panel is empty or gone.
   */
  async probeFollowRequestHead(): Promise<LocateConfirmRequestResult> {
    return this.tab.evaluate<LocateConfirmRequestResult>(
      SURFACE.locateConfirmFollowRequestScript(),
    );
  }

  /**
   * Scroll the followers dialog to its bottom to trigger the next paginated
   * followers request. The version module's script locates the scroll
   * container (largest scrollable descendant of the dialog).
   */
  async scrollFollowers(): Promise<boolean> {
    return listScroll.scrollFollowersDriven(this.scrollDeps());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One find-and-act attempt: the surface's locate script searches the header
   * anchor and reports the button's state, rect, and whether `op` would press
   * it; the Interactor performs the press.
   */
  private async findAndAct(op: 'follow' | 'unfollow', dispatch: () => Promise<void>,
    watch: MutationWatch): Promise<FindButtonResult> {
    const res = await this.tab.evaluate<LocateActionResult>(
      SURFACE.locateActionButtonScript(op),
    );
    if (!res?.found) return { found: false };
    // A would-click button with an unpressable rect (hidden/off-screen) is
    // treated as not-found so the wait loop retries through hydration — never
    // pressed at a garbage point and "verified" as a success.
    if (res.wouldClick && !Actor.rectUsable(res.rect)) return { found: false };
    const clicked = Boolean(res.wouldClick && res.rect);
    if (clicked && res.rect) {
      await dispatch(); // one admission per action, before its first press (ADR 0308)
      await this.interactor.click(res.rect);
      watch.markPress();
    }
    return {
      found: true,
      state: res.state ?? 'unknown',
      clicked,
      needsConfirm: clicked && Boolean(res.needsConfirm),
    };
  }

  /** One stat-control click attempt: locate the clickable ancestor, press its rect. */
  private async clickStat(which: 'followers' | 'following'): Promise<ClickResult> {
    const script =
      which === 'followers'
        ? SURFACE.locateFollowersStatScript()
        : SURFACE.locateFollowingStatScript();
    const res = await this.tab.evaluate<LocateRectResult>(script);
    if (!res?.found || !Actor.rectUsable(res.rect)) return { clicked: false };
    await this.interactor.click(res.rect);
    return { clicked: true };
  }

  /** The slice of the Actor a list-scroll round drives (`actor-scroll.ts`). */
  private scrollDeps(): listScroll.ScrollDeps {
    return { tab: this.tab, interactor: this.interactor, rectUsable: Actor.rectUsable, tempo: this.tempo };
  }

  /** Settle-then-press a rail/drawer control (see `settle-press.ts`). */
  private settleAndPress<T extends { found: boolean; rect?: LocatedRect; aim?: LocatedRect }>(
    located: T | null,
    locate: () => Promise<T>,
  ): Promise<T | null> {
    return settleAndPress(this.interactor, located, locate, Actor.rectUsable);
  }

  /**
   * Poll `run` until `done` is satisfied, the timeout elapses, or the ACTIVE
   * driver's abort signal fires (a `stop()` must not sit out an 8s poll).
   *
   * An abort THROWS {@link ActionAbortedError} instead of resolving `null`:
   * `null` is the "control absent" shape callers escalate to
   * `AdapterStaleError` — burning a retry and a failed ledger row — and a user
   * pressing Stop is neither selector drift nor a failure. Without a signal
   * at least one attempt always runs, even with a zero/negative timeout.
   */
  private async waitFor<T>(
    op: string,
    run: () => Promise<T>,
    done: (value: T) => boolean,
    metric?: SurfaceMetric,
  ): Promise<T | null> {
    const signal = this.abortSignal?.();
    const startedAt = Date.now();
    const deadline = startedAt + this.pollTimeoutMs;
    for (;;) {
      if (signal?.aborted) throw new ActionAbortedError(op);
      const value = await run();
      if (done(value)) {
        // Successful samples only: a wait that TIMED OUT measures the deadline,
        // not the page, and feeding it back would grow the timeout into itself.
        if (metric !== undefined) SURFACE_METER.record(metric, Date.now() - startedAt);
        return value;
      }
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
  private async probeBlock(op: string): Promise<string | null> {
    let text = '';
    try {
      const probed = await this.tab.evaluate<unknown>(SURFACE.bodyTextProbeScript());
      if (typeof probed === 'string') text = probed;
    } catch (e) {
      logger.debug('actor.blockProbe: body-text probe failed', { op, error: String(e) });
      return null;
    }
    if (text.trim() === '') return null;
    for (const sig of SURFACE.textSignatures) {
      if (sig.pattern.test(text)) {
        logger.warn('actor: block interstitial detected in place of expected control', {
          op,
          matched: String(sig.pattern),
        });
        return String(sig.pattern);
      }
    }
    logger.warn('actor: post-click state unconfirmed and no block signature in the dialog/heading text', {
      op,
      textHead: text.slice(0, 200),
    });
    return null;
  }

  /**
   * Decide a dispatched click's outcome — ONE call, for both follow and
   * unfollow. The evidence is gathered here (the armed mutation response, the
   * DOM post-state, the on-screen block probe) and {@link arbitrate} turns it
   * into a {@link Verdict}; {@link Actor.toResult} maps that Verdict onto the
   * `Result`/error contract `churn-actions.ts` still consumes.
   *
   * Wave-B seam: the engine adopts the Verdict's own `effect` and this mapping
   * (and `ActionRateLimitedError`/`ActionBlockedError`) deletes.
   */
  private async decide(f: LayerFlow, stateBefore: ButtonState | undefined): Promise<Result<{ clicked: boolean }>> {
    const observed = await f.watch.next(this.mutationTimeoutMs, this.abortSignal?.());
    if (observed === null && f.watch.available) await noteUnobserved(f);
    const latencyMs = f.watch.latencyMs();
    // Successful samples only: a window that expired measures the timeout, not
    // Instagram, and feeding it back would make the timeout grow into itself.
    if (observed !== null && latencyMs !== null) {
      SURFACE_METER.record('mutation-arrival', latencyMs);
    }

    const verdict = await arbitrate({
      op: watchKind(f.op),
      label: f.op,
      observed,
      watchAvailable: f.watch.available,
      latencyMs,
      stateBefore,
      verifyPostState: () => this.verifyPostState(f.settled),
      probeBlock: () => this.probeBlock(f.op),
      now: () => Date.now(),
    });
    return verdictToResult(verdict, f.op, f.username);
  }

  /**
   * Poll the action button's leading state until `accept(state)` holds or the
   * timeout elapses. `true` only when the expected post-state is observed.
   */
  private async verifyPostState(accept: (state: ButtonState) => boolean): Promise<boolean> {
    const probe = await this.waitFor<ProbeStateResult>(
      'actor.verifyPostState',
      () => this.tab.evaluate<ProbeStateResult>(SURFACE.probeStateScript()),
      (r) => Boolean(r?.found && accept(r.state)),
    );
    return Boolean(probe?.found && accept(probe.state));
  }

  /**
   * Re-throw an error escaping the POST-CLICK region: a `TabUnresponsiveError`
   * is re-thrown annotated with `phase: 'post-click'` (the click was dispatched,
   * so the action may have landed on Instagram unverified); everything else
   * passes through untouched. Declared `never` so callers keep flow analysis.
   */
  private static rethrowMarkedPostClick(e: unknown): never {
    if (e instanceof TabUnresponsiveError && e.phase === undefined) {
      throw new TabUnresponsiveError(e.component, e.timeoutMs, 'post-click');
    }
    throw e;
  }
}
