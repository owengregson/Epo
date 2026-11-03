/**
 * The live column's gallery data (spec §12.2): one consistent Balanced day (30 follows, 10 unfollows and 4
 * approvals = 44 of a 48 maximum), a feed that shows every row kind, and the slice of the Settings view the
 * column reads. Times are relative to when the gallery opens. Names are invented.
 */
import { settingsFactsSignal, settingsViewSignal } from '@/renderer/app/shell-context';
import { GALLERY_SETTINGS_FACTS, GALLERY_SETTINGS_VIEW } from '@/renderer/gallery/settings-fixture';
import type { BoostPreview, BoostView } from '@/shared/boost';
import type { FeedItem, FeedView, Person } from '@/shared/feed';
import type { PlanProjection } from '@/shared/plan-projection';
import type { CatchUpView } from '@/shared/reopen-view';

export const NOW = Date.now();
export const MIN = 60_000;
export const HOUR = 60 * MIN;

type Session = PlanProjection['sessions'][number];
const session = (idx: number, state: Session['state'], from: number, hours: number, planned: number, done: number): Session => ({
  idx, startAt: NOW + from * HOUR, endAt: NOW + (from + hours) * HOUR, planned, done, state,
  mix: 'normal', probation: false, censusHost: false, pace: idx % 3 === 0 ? 'relaxed' : idx % 3 === 1 ? 'normal' : 'quick',
});

/** Today's plan, mid-session: two sessions done, one running, two ahead. */
export function livePlan(over: Partial<PlanProjection> = {}): PlanProjection {
  return {
    day: {
      key: 'gallery', startsAt: NOW - 9 * HOUR, endsAt: NOW + 15 * HOUR, quietMinute: 150, light: false,
      lateStart: false, binding: 'none', dayOff: false,
    },
    revision: 4, cause: 'day-start',
    totals: { planned: 44, done: 26, remaining: 18, automaticMax: 48, ceiling: 65, outside: 0 },
    kinds: { follow: { planned: 30, done: 18 }, unfollow: { planned: 10, done: 6 }, accept: { planned: 4, done: 2 } },
    reads: { profiles: { planned: 90, done: 51 }, pages: { planned: 12, done: 7 }, checks: { planned: 4, done: 2 } },
    sessions: [
      session(0, 'done', -6.5, 0.8, 9, 9), session(1, 'partial', -4, 0.7, 8, 5),
      session(2, 'now', -0.4, 0.9, 10, 4), session(3, 'next', 2.2, 0.8, 9, 0), session(4, 'later', 5.1, 0.7, 8, 0),
    ],
    now: { sessionIdx: 2, nextAt: NOW + 2.2 * HOUR, closesAt: NOW + 0.5 * HOUR },
    detail: { caps: { automaticMax: 48, day: 65, hour: 22, unfollowHour: 22, probationHour: 14, acceptsPerPass: 4 }, sessions: [] },
    ...over,
  };
}

/** The plan between sessions: the running one has ended, the next starts later. */
export function restingPlan(): PlanProjection {
  const p = livePlan();
  const sessions = p.sessions.map((s) => (s.state === 'now' ? { ...s, state: 'done' as const, done: s.planned } : s));
  return { ...p, sessions, now: { sessionIdx: null, nextAt: NOW + 2.2 * HOUR, closesAt: null } };
}

/** A late first open: the day's sessions passed before Epo opened, so nothing is planned. */
export function lateStartPlan(): PlanProjection {
  const p = livePlan();
  const sessions = p.sessions.slice(0, 3).map((s) => ({ ...s, state: 'before-open' as const, done: 0 }));
  return {
    ...p, sessions, day: { ...p.day, lateStart: true },
    totals: { ...p.totals, planned: 0, done: 0, remaining: 0 },
    kinds: { follow: { planned: 0, done: 0 }, unfollow: { planned: 0, done: 0 }, accept: { planned: 0, done: 0 } },
    now: { sessionIdx: null, nextAt: NOW + 14 * HOUR, closesAt: null },
  };
}

/** A zero-volume light day: the plan drew no actions. */
export function lightPlan(): PlanProjection {
  const p = lateStartPlan();
  return { ...p, sessions: [], day: { ...p.day, lateStart: false, light: true, binding: 'light-day' } };
}

/** A day the person set off. */
export function dayOffPlan(): PlanProjection {
  const p = lightPlan();
  return { ...p, day: { ...p.day, light: false, dayOff: true, binding: 'day-off' } };
}

export function boostView(over: Partial<BoostView> = {}): BoostView {
  return {
    state: 'on', startedAt: NOW - 1.2 * HOUR, endsAt: NOW + 7.2 * HOUR, effectiveFrom: NOW - 1.2 * HOUR,
    followsDuring: 7, lastEnded: null, ...over,
  };
}

export function boostPreview(over: Partial<BoostPreview> = {}): BoostPreview {
  return {
    hours: 12, endsAt: NOW + 12 * HOUR, effectiveFrom: NOW, startsSessionNow: false, extraFollowsToday: 9,
    unfollowsWaiting: 6, why: 'ready', ...over,
  };
}

export function catchingUp(): CatchUpView {
  return {
    state: 'running', mode: 'launch', skipped: null, isReturn: true, since: NOW - 11 * HOUR, startedAt: NOW - 20_000,
    finishedAt: null, summary: null,
    steps: [
      { id: 'profile', step: { state: 'done', found: 1 } },
      { id: 'notifications', step: { state: 'running' } },
      { id: 'followers-head', step: { state: 'pending' } },
    ],
  };
}

const who = (username: string, pk: string): Person => ({ pk, username });
const people = (n: number, from: number): Person[] =>
  Array.from({ length: n }, (_, i) => who(['mira.lens', 'tomas.k', 'ana.roams', 'leo.draws', 'june.makes', 'kai.loops'][i % 6] ?? 'x', String(from + i)));

/** A feed with every row kind; the oldest rows are from before the person left. */
export function liveFeed(away: boolean): FeedView {
  const at = (minutesAgo: number): number => NOW - minutesAgo * MIN;
  const items: FeedItem[] = [
    { id: 'f1', at: at(1), kind: 'followed', people: [who('studio.lumen', '11')], via: 'plan', practice: false },
    { id: 'f2', at: at(14), kind: 'followed-back', person: who('ana.roams', '12'), afterMs: 2 * 24 * HOUR, dated: true },
    { id: 'f3', at: at(32), kind: 'followed', people: people(6, 20), via: 'plan', practice: false },
    { id: 'f4', at: at(48), kind: 'unfollowed', people: [who('old.feed', '13')], why: 'no-follow-back', practice: false },
    { id: 'f5', at: at(70), kind: 'kept', person: who('best.friend', '14'), reason: 'account' },
    { id: 'f6', at: at(95), kind: 'new-followers', people: people(3, 40), dated: true },
    { id: 'f7', at: at(130), kind: 'not-done', action: 'follow', person: who('quiet.one', '15'), why: 'unconfirmed' },
    ...(away
      ? [{ id: 'f8', at: at(150), kind: 'caught-up', summary: { awayFrom: at(800), checkedAt: at(150), newFollowers: 14, followBacks: 6, left: 2 } } as const]
      : []),
    { id: 'f9', at: at(820), kind: 'unfollowed', people: people(4, 60), why: 'clean-up', practice: false },
    { id: 'f10', at: at(26 * 60), kind: 'lost-followers', count: 2 },
  ];
  return {
    items, awayFrom: away ? at(800) : null, windowStart: NOW - 7 * 24 * HOUR, shapedAt: NOW,
    days: [{ key: 'today', startsAt: NOW - 9 * HOUR }, { key: 'yesterday', startsAt: NOW - 33 * HOUR }],
  };
}

/**
 * The live column's slice of the Settings view (the Boost capability and length, practice mode, the starting
 * account) over the Settings stage's full gallery view, and the store facts beside it (no seed → none).
 */
export function setGalleryView(o: { boost: boolean; practice?: boolean; seed?: string }): void {
  const view = settingsViewSignal.peek() ?? GALLERY_SETTINGS_VIEW;
  settingsViewSignal.value = {
    ...view,
    seed: o.seed ?? view.seed,
    capabilities: { ...view.capabilities, boost: o.boost },
    prefs: { ...view.prefs, practice: o.practice ?? false },
  };
  const facts = settingsFactsSignal.peek() ?? GALLERY_SETTINGS_FACTS;
  settingsFactsSignal.value = o.seed === '' ? { ...facts, seed: { kind: 'none' } } : facts;
}
