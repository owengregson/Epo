/**
 * The notifications drawer's pass (spec §9.4): one read since the watermark. Every fresh event, undated
 * event and requester reaches the caller as its body parses (docs/PRINCIPLES.md §1); the Follows chip is
 * pressed once it is ready; the drawer scrolls only while the watermark is unreached; the requests panel
 * opens only to accept or to verify. A failure is typed, never an empty success.
 */

import { type ActivityReporter, NOOP_ACTIVITY_REPORTER } from '@/adapter/activity-reporter';
import type { Actor } from '@/adapter/actor';
import type { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import type { FollowEvent, Observation } from '@/adapter/surface-types';
import type { ReadBudget } from '@/governors/read-budget';
import { type TempoSource, tempoOrReference } from '@/kernel/tempo';
import { CLOCK_TOLERANCE_MS } from '@/kernel/tempo-policy';
import { awaitCaptured, type CaptureState, captureFeed } from '@/rim/feed-capture';
import type {FeedFailure, FeedPassOptions, FeedReadResult, FeedSource, NotificationsActor,
} from '@/rim/feed-source';
import { advanceWatermark, classifyBody, eventKey, type FeedWatermark, gapOf, reached } from '@/rim/feed-watermark';
import { createIgActivityClock, type IgActivityClock } from '@/rim/ig-activity-clock';
import type { RimTab } from '@/rim/types';
import type { KnowledgeStore } from '@/store/knowledge-store';
import { RIM } from '@/timing/config';
import { sample, sleep } from '@/timing/primitives';
import * as logger from '@/utils/logger';
import { acceptRequests } from './request-acceptance';

export type { FollowEvent } from '@/adapter/surface-types';
export type {
  AcceptedFollowRequest, FeedFailure, FeedPanel, FeedPassOptions, FeedReadResult, FeedRequester, FeedSource, NotificationsActor,
} from '@/rim/feed-source';

export interface FollowNotificationsDeps {
  readBudget?: ReadBudget;
  ownPk?: string;
  canAccept?: () => Promise<boolean>;
  onAccepted?: () => void;
  tab: RimTab;
  actor: NotificationsActor | Actor;
  reader: Reader;
  sentinel: Sentinel;
  /** The accept journal (intents per request) and the pending-row facts. */
  store?: KnowledgeStore;
  /** How long to wait for an observed response after a click (default: the D4 deadline). */
  responseWaitMs?: number;
  /** How long an accept click may take to visibly consume its row. */
  acceptVerifyMs?: number;
  /** Injected for tests; defaults to a real `setTimeout` sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Provider of the ACTIVE driver's abort signal — a stop() ends the pass. */
  abortSignal?: () => AbortSignal | undefined;
  /** Live activity readout for the veil; defaults to a no-op. */
  reporter?: ActivityReporter;
  /** The tempo the drawer's waits and step pauses resolve from (default: the reference tempo). */
  tempo?: TempoSource;
  /** The graph's activity clock: the drawer opens a drawn dwell after the last operation ended (default: its own). */
  activity?: IgActivityClock;
  /** Local time (default `Date.now`). */
  now?: () => number;
}

/** Why a pass that opened the drawer read no feed body. */
function noBody(s: CaptureState): FeedFailure {
  if (s.feedWalled) return 'walled';
  if (s.feedDrift) return 'feed-shape-drift';
  return s.sawFeed ? 'body-unreadable' : 'no-response';
}

/** What one pass has handed over so far: dedupe keys, the fresh events, the requester rows by source. */
class PassTally {
  readonly handed = new Set<string>();
  readonly merged = new Set<string>();
  readonly requesters = new Set<string>();
  readonly fresh: FollowEvent[] = [];
  readonly sibling = new Set<string>();
  readonly panel = new Map<string, string>();
  panelRead = false;
  panelComplete = false;
  oldest: number | null = null;
}

export class AdapterBackedFollowNotifications implements FeedSource {
  private readonly d: FollowNotificationsDeps;
  private readonly actor: NotificationsActor;
  private readonly responseWaitMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly reporter: ActivityReporter;
  private readonly tempo: TempoSource;
  private readonly now: () => number;
  private readonly activity: IgActivityClock;

  constructor(deps: FollowNotificationsDeps) {
    this.d = deps;
    this.actor = deps.actor;
    this.responseWaitMs = deps.responseWaitMs ?? RIM.NOTIFICATIONS_WAIT_MS;
    this.sleep = deps.sleep ?? sleep;
    this.reporter = deps.reporter ?? NOOP_ACTIVITY_REPORTER;
    this.tempo = tempoOrReference(deps.tempo);
    this.now = deps.now ?? Date.now;
    this.activity = deps.activity ?? createIgActivityClock({ tempo: this.tempo, now: this.now, sleep: this.sleep });
  }

  async fetchSince(w: FeedWatermark | null, o: FeedPassOptions): Promise<FeedReadResult> {
    const permit = this.d.readBudget?.consume('notification', 'reconciliation', 1, o.use);
    if (permit && !permit.allowed) return { ok: false, reason: 'read-budget', retryAt: permit.resumeAt ?? undefined, opened: false };
    // The drawer opens on the activity clock (spec §5.16), then looks at the page it opens on.
    await this.activity.spaceEntry(o.signal);
    if (o.signal.aborted) return { ok: false, reason: 'aborted', opened: false };
    const status = await this.d.sentinel.check();
    if (status !== 'ok') {
      logger.warn('rim.follow-notifications: sentinel non-ok, skipping the pass', { status });
      return { ok: false, reason: `sentinel:${status}`, opened: false };
    }
    this.reporter.report({ kind: 'page', op: { op: 'check-notifications' } });
    try {
      return await this.pass(w, o);
    } finally {
      this.activity.noteEnd(this.now());
      this.reporter.clear();
    }
  }

  private async pass(w: FeedWatermark | null, o: FeedPassOptions): Promise<FeedReadResult> {
    const readAt = this.now();
    const t = new PassTally();
    const once = (key: string, seen: Set<string>): boolean => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    };
    const requester = (obs: Observation, into: 'sibling' | 'panel'): void => {
      const username = obs.fields.username;
      if (typeof username !== 'string') return;
      if (into === 'sibling') t.sibling.add(obs.accountPk);
      else t.panel.set(username.toLowerCase(), obs.accountPk);
      if (once(obs.accountPk, t.requesters)) o.onRequester({ pk: obs.accountPk, username, observation: obs });
    };
    const cap = captureFeed({ tab: this.d.tab, reader: this.d.reader, now: this.now }, {
      onFeed: (events, preview) => {
        const c = classifyBody(events, w, readAt, CLOCK_TOLERANCE_MS);
        if (c.oldestAtMs !== null) t.oldest = t.oldest === null ? c.oldestAtMs : Math.min(t.oldest, c.oldestAtMs);
        for (const e of events) t.merged.add(eventKey(e));
        for (const e of c.fresh) {
          if (!once(eventKey(e), t.handed)) continue;
          t.fresh.push(e);
          o.onEvent(e);
        }
        for (const e of c.undated) if (once(eventKey(e), t.handed)) o.onUndated(e);
        for (const r of preview) requester(r, 'sibling');
      },
      onRequests: (rows, complete) => {
        t.panelRead = true;
        t.panelComplete = complete;
        for (const r of rows) requester(r, 'panel');
      },
    });
    const { signal } = o;
    const fail = (reason: FeedFailure): FeedReadResult => ({ ok: false, reason, opened: true });
    try {
      if (!await this.actor.clickNotifications()) {
        logger.warn('rim.follow-notifications: notifications control not located, skipping');
        return { ok: false, reason: 'control-not-located', opened: false };
      }
      const deadline = this.now() + this.responseWaitMs;
      const wait = (done: () => boolean, until = deadline): Promise<void> => awaitCaptured(done, cap.pendingReads,
        { signal, deadline: until, now: this.now, pollMs: RIM.NOTIFICATIONS_POLL_MS, sleep: this.sleep });
      await wait(() => cap.state.feedBodies > 0 || cap.state.feedDrift || cap.state.feedWalled);
      if (signal.aborted) return fail('aborted');
      if (cap.state.feedBodies === 0) {
        logger.warn('rim.follow-notifications: no readable feed body after the open', { ...cap.state });
        return fail(noBody(cap.state));
      }
      const filtered = await this.pressFollows(cap.state, wait, deadline, signal);
      // Older bodies only while the watermark is unreached; a round that adds nothing ends it.
      for (let round = 0; round < RIM.NOTIFICATIONS_SCROLL_ROUNDS && !reached(w, t.oldest); round++) {
        if (signal.aborted) break;
        const before = t.merged.size;
        if (!await this.actor.scrollNotificationsList()) break;
        await this.sleep(sample(this.tempo.policy('scroll.wait.drawer')), signal);
        await Promise.all(cap.pendingReads.splice(0));
        if (t.merged.size === before) break;
      }
      if (signal.aborted) return fail('aborted');
      const accepted = await this.openPanel(o, cap.state, t.panel, wait, signal);
      const gap = gapOf(w, t.oldest);
      const requesters = t.panelRead
        ? { count: t.panel.size, source: 'panel' as const, complete: t.panelComplete }
        : { count: t.sibling.size, source: t.sibling.size > 0 ? 'sibling' as const : 'none' as const, complete: false };
      logger.info('rim.follow-notifications: pass complete', { bodies: cap.state.feedBodies, fresh: t.fresh.length,
        filtered, gap: gap !== null, requesters: requesters.count, source: requesters.source, accepted });
      return { ok: true, next: advanceWatermark(w, t.fresh, readAt, filtered, gap), bodies: cap.state.feedBodies,
        filtered, fresh: t.fresh.length, requesters, accepted };
    } finally {
      cap.unsubscribe();
      await this.close();
    }
  }

  /** Press the Follows chip once it is ready, then wait for the body it filters (one D4 deadline). */
  private async pressFollows(s: CaptureState, wait: (done: () => boolean) => Promise<void>, deadline: number,
    signal: AbortSignal): Promise<boolean> {
    let pressed = false;
    let before = s.feedBodies;
    while (!pressed && this.now() < deadline && !signal.aborted) {
      await this.attemptPause(signal);
      // Any body that lands from the press on is the filtered one.
      before = s.feedBodies;
      pressed = await this.actor.clickNotificationsFollowsFilter();
    }
    if (!pressed) {
      logger.info('rim.follow-notifications: Follows filter not ready, reading the full feed');
      return false;
    }
    await wait(() => s.feedBodies > before);
    if (s.feedBodies > before) return true;
    logger.info('rim.follow-notifications: no body after the Follows filter, reading the full feed');
    return false;
  }

  /** The requests panel, for an accept pass or a verification read; returns the accepts. */
  private async openPanel(o: FeedPassOptions, s: CaptureState, rows: Map<string, string>,
    wait: (done: () => boolean, until?: number) => Promise<void>, signal: AbortSignal): Promise<number> {
    const p = o.panel;
    if (p === null || signal.aborted || (p.mode === 'accept' && p.allowed <= 0)) return 0;
    await this.stepPause(signal);
    if (!await this.actor.clickFollowRequestsEntry()) {
      logger.debug('rim.follow-notifications: no Follow requests entry (nothing pending)');
      return 0;
    }
    await wait(() => s.requestBodies > 0 || s.requestsFailure === 'requests-walled', this.now() + this.responseWaitMs);
    if (p.mode === 'verify' || s.requestBodies === 0) return 0;
    let accepted = 0;
    try {
      const { store, ownPk, canAccept, onAccepted } = this.d;
      await acceptRequests({ actor: this.actor, store, ownPk, canAccept, onAccepted, cap: p.allowed,
        acceptVerifyMs: this.d.acceptVerifyMs ?? RIM.ACCEPT_VERIFY_MS, sleep: this.sleep, tempo: this.tempo, now: this.now }, rows, (a) => {
        accepted += 1;
        o.onAccepted?.({ ...a, at: this.now() });
      }, signal);
    } catch (e) {
      logger.warn('rim.follow-notifications: the accept pass ended early', { error: String(e), accepted });
    }
    return accepted;
  }

  /** Leave the drawer through its own X control (the bell when none); every next operation navigates anyway. */
  private async close(): Promise<void> {
    try {
      await this.sleep(sample(this.tempo.policy('drawer.close-settle')), this.d.abortSignal?.());
      if (!await this.actor.clickNotificationsClose()) await this.actor.clickNotifications();
    } catch (e) {
      logger.debug('rim.follow-notifications: drawer close skipped', { error: String(e) });
    }
  }

  /** A reading pause between two presses of one drawer flow (`ui.step-pause`; off at identity). */
  private async stepPause(signal: AbortSignal | undefined): Promise<void> {
    if (this.tempo.enabled('ui.step-pause')) await this.sleep(sample(this.tempo.policy('ui.step-pause')), signal);
  }

  /** Before each chip attempt: the step pause, or one response poll while it is off. */
  private async attemptPause(signal: AbortSignal): Promise<void> {
    if (this.tempo.enabled('ui.step-pause')) await this.stepPause(signal);
    else await this.sleep(RIM.NOTIFICATIONS_POLL_MS, signal);
  }
}
