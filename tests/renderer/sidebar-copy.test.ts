/**
 * Law L-COPY (spec §20.1, Appendix C.15, §18.3): every sentence the live column can say — postures,
 * attentions, refusals, "Why?", the zones, the feed, Boost and the live ops — uses no banned word, never
 * shows a raw key or an unfilled slot, keeps headlines to 15 characters, says "Prune" for the cleanup
 * feature, and carries no literal duration or count: every number arrives from a projection.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSync } from '@swc/core';
import { BOOST_COPY } from '@/renderer/copy/boost';
import { STOP_TOAST, UNDO } from '@/renderer/hooks/useTransportControls';
import { UPDATE_TOAST } from '@/renderer/hooks/useUpdateToasts';
import { BOOST_NEEDS_PLAN, bandLine, buttonLabel, PAUSED_REASON, previewLine } from '@/renderer/sidebar/boost-copy';
import { attentionCode, attentionSentence, SCHEDULES_WAIT, UNKNOWN_ATTENTION } from '@/renderer/sidebar/copy/attention-copy';
import { explainText } from '@/renderer/sidebar/copy/explain-copy';
import { FEED_EMPTY, rowFace, SOMEONE, sinceYouLeft } from '@/renderer/sidebar/copy/feed-copy';
import { headlineOf, nextLineOf, PILL, PRIMARY_FACE, SECONDARY_LABEL, sentenceOf } from '@/renderer/sidebar/copy/posture-copy';
import { COMMAND_FAILED, KNOWN_REFUSALS, refusalText } from '@/renderer/sidebar/copy/refusal-copy';
import {
  approvalsNote, FEED_TITLE, FOOTER, freshPill, GET_STARTED, NO_PLAN, RESULTS, sessionTip, TODAY_TITLE, todayNext,
  todaySummary,
} from '@/renderer/sidebar/copy/zone-copy';
import { classifyBlock, KNOWN_BLOCK_KEYS } from '@/shared/attention';
import type { BoostView } from '@/shared/boost';
import type { FeedItem } from '@/shared/feed';
import { type LiveOp, liveOpText } from '@/shared/live-op';
import type { PlanProjection } from '@/shared/plan-projection';
import { type ExplainTopic, type Posture, type PostureKind, postureHeadline } from '@/shared/posture';
import type { EpoStatus } from '@/types';
import { idlePruneStatus, idleStatus } from '../kit/render-bridge';

const ROOT = path.resolve(__dirname, '..', '..');
const T = Date.UTC(2026, 10, 3, 18, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

const KINDS = {
  'starting-up': true, 'data-unavailable': true, 'signed-out': true, 'needs-attention': true, sleeping: true,
  reconnecting: true, offline: true, 'cleaning-up': true, 'catching-up': true, starting: true, paused: true,
  'needs-seed': true, stopped: true, 'taking-a-break': true, 'day-off': true, 'done-for-today': true, pacing: true,
  retrying: true, resting: true, working: true,
} as const satisfies Record<PostureKind, true>;
const ALL_KINDS = Object.keys(KINDS) as PostureKind[];

const TOPICS = {
  resting: true, 'pacing-hour': true, 'pacing-visits': true, retrying: true, 'taking-a-break': true,
  'done-for-today': true, 'day-off': true, 'catching-up': true, boost: true, practice: true,
} as const satisfies Record<ExplainTopic, true>;

const plan: PlanProjection = {
  day: { key: 'd', startsAt: T - 9 * HOUR, endsAt: T + 15 * HOUR, quietMinute: 0, light: false, lateStart: false, binding: 'none', dayOff: false },
  revision: 3, cause: 'day-start',
  totals: { planned: 44, done: 26, remaining: 18, automaticMax: 48, ceiling: 65, outside: 0 },
  kinds: { follow: { planned: 30, done: 18 }, unfollow: { planned: 10, done: 6 }, accept: { planned: 4, done: 2 } },
  reads: { profiles: { planned: 0, done: 0 }, pages: { planned: 0, done: 0 }, checks: { planned: 0, done: 0 } },
  sessions: [
    { idx: 0, startAt: T - 6 * HOUR, endAt: T - 5 * HOUR, planned: 12, done: 12, state: 'done', mix: 'normal', probation: false, censusHost: false, pace: 'relaxed' },
    { idx: 1, startAt: T - 2 * HOUR, endAt: T - HOUR, planned: 10, done: 0, state: 'skipped', mix: 'normal', probation: false, censusHost: false, pace: 'normal' },
    { idx: 2, startAt: T + 2 * HOUR, endAt: T + 3 * HOUR, planned: 12, done: 0, state: 'before-open', mix: 'boost', probation: false, censusHost: false, pace: 'quick' },
  ],
  now: { sessionIdx: null, nextAt: T + 2 * HOUR, closesAt: null },
  detail: { caps: { automaticMax: 48, day: 65, hour: 22, unfollowHour: 22, probationHour: 14, acceptsPerPass: 4 }, sessions: [] },
};

const boost = (over: Partial<BoostView>): BoostView => ({
  state: 'on', startedAt: T - HOUR, endsAt: T + 7 * HOUR, effectiveFrom: T + 2 * HOUR, followsDuring: 4, lastEnded: null, ...over,
});

function posture(kind: PostureKind, over: Partial<Posture> = {}): Posture {
  return {
    kind, tone: 'live', driver: kind === 'cleaning-up' ? 'prune' : 'growth', primary: null, secondary: null,
    countdown: null, busy: false, attention: null, overlay: { boost: false, practice: false, careful: false },
    explain: null, ...over,
  };
}

const statuses: EpoStatus[] = [
  idleStatus(),
  idleStatus({ lastActionAt: T - HOUR, plan, currentTargetUsername: 'studio.lumen' }),
  idleStatus({
    state: 'running', parkReason: 'read-budget', parkedUntil: T + HOUR, plan: { ...plan, totals: { ...plan.totals, planned: 0 }, day: { ...plan.day, lateStart: true } },
    recovery: { phase: 'holding', attempt: 2, maxAttempts: 3, resumeAt: T + 20 * MIN },
    boot: { phase: 'live', identity: 'signed-in', data: 'unavailable', dataProblem: 'locked', tab: 'settled', ig: 'ready', startedAt: T, revealBy: T, startup: { step: 'confirm-account', startQueued: true, done: false } },
    runtime: { desired: 'running', phase: 'recovering', blockedReason: null, lastProgressAt: null, progressPhase: null, incidents: [] },
  }),
  idleStatus({ state: 'running', parkReason: 'daily-ceiling', plan: { ...plan, totals: { ...plan.totals, planned: 0 }, day: { ...plan.day, light: true } } }),
];

const ops: LiveOp[] = [
  { op: 'follow', username: 'jane' }, { op: 'unfollow', username: 'carl' }, { op: 'accept-request', username: 'dana' },
  { op: 'open-list', list: 'followers', of: 'studio.lumen' },
  { op: 'browse-list', list: 'following', of: null, done: 120, total: null },
  { op: 'read-list', list: 'followers', of: 'studio.lumen', done: 120, total: 250 },
  { op: 'visit-profiles', done: 3, total: 20 },
  ...(['check-back', 'verify', 'settle', 'seed'] as const).map((purpose): LiveOp => ({ op: 'visit-profile', username: 'bob', purpose })),
  { op: 'check-notifications' }, { op: 'open-own-profile' }, { op: 'confirm-account' },
];

const person = (username: string | null) => ({ pk: username ?? '0', username });
const at = { id: 'i', at: T };
const feedItems: FeedItem[] = [
  { ...at, kind: 'followed', people: [person('jane')], via: 'boost', practice: false },
  { ...at, kind: 'followed', people: [person('a'), person('b'), person('c')], via: 'you', practice: true },
  ...(['no-follow-back', 'after-follow-back', 'clean-up', 'you', 'other'] as const).map(
    (why): FeedItem => ({ ...at, kind: 'unfollowed', people: [person('carl')], why, practice: false }),
  ),
  { ...at, kind: 'followed-back', person: person('bob'), afterMs: 5 * HOUR, dated: true },
  { ...at, kind: 'new-followers', people: [person('d'), person(null)], dated: false },
  { ...at, kind: 'lost-followers', count: 2 },
  { ...at, kind: 'request-accepted', people: [person('erin'), person('fay')] },
  ...(['refused', 'unavailable', 'unconfirmed', 'error'] as const).map(
    (why): FeedItem => ({ ...at, kind: 'not-done', action: 'accept', person: person('jane'), why }),
  ),
  ...['account', 'verified', 'bio-word', 'source', 'unreadable-bio', 'unreadable-verified', 'unknown-reason'].map(
    (reason): FeedItem => ({ ...at, kind: 'kept', person: person('friend'), reason }),
  ),
  { ...at, kind: 'boost', edge: 'started', endsAt: T + HOUR, why: null },
  ...(['user', 'expired', 'clock'] as const).map((why): FeedItem => ({ ...at, kind: 'boost', edge: 'ended', endsAt: null, why })),
  { ...at, kind: 'slowed-down', until: T + HOUR },
  { ...at, kind: 'resumed', after: 'restart' },
  { ...at, kind: 'caught-up', summary: { awayFrom: T - HOUR, checkedAt: T, newFollowers: 1, followBacks: 0, left: 3 } },
];

/** Every sentence the column's decks can produce over the fixtures above. */
function everySentence(): string[] {
  const out: string[] = [];
  const prune = [idlePruneStatus({ state: 'paused' }), idlePruneStatus({ state: 'scanning' }), idlePruneStatus({ state: 'running' })];
  for (const kind of ALL_KINDS) {
    out.push(postureHeadline(kind));
    for (const status of statuses) {
      for (const p of [null, ...prune]) {
        const facts = { status, prune: p, now: T };
        for (const over of [{}, { overlay: { boost: true, practice: false, careful: false } }, { overlay: { boost: false, practice: false, careful: true } }]) {
          for (const countdown of [null, { from: T - MIN, to: T + 90_000, toward: 'next-step' as const }, { from: T, to: T + 3 * HOUR, toward: 'next-session' as const }]) {
            const p0 = posture(kind, { ...over, countdown });
            out.push(headlineOf(p0, p), sentenceOf(p0, facts), nextLineOf(p0, facts) ?? '');
          }
        }
      }
    }
  }
  for (const key of KNOWN_BLOCK_KEYS) {
    for (const counts of [
      { maxAttempts: null, unconfirmed: null },
      { maxAttempts: 3, unconfirmed: { kind: 'unfollow' as const, streak: 2 } },
      { maxAttempts: 3, unconfirmed: { kind: 'follow' as const, streak: 1 } },
    ]) {
      out.push(attentionSentence(classifyBlock(key), counts));
    }
    expect({ key, code: attentionCode(classifyBlock(key)) }).toEqual({ key, code: null });
  }
  out.push(attentionSentence(classifyBlock('a-key-epo-does-not-know'), { maxAttempts: null, unconfirmed: null }));
  out.push(UNKNOWN_ATTENTION, SCHEDULES_WAIT, COMMAND_FAILED);
  for (const reason of [...KNOWN_REFUSALS, 'a-refusal-epo-does-not-know']) out.push(refusalText(reason) ?? '');
  for (const topic of Object.keys(TOPICS) as ExplainTopic[]) {
    out.push(explainText(topic, { sessions: null, visitsAt: null, attempt: null, lateOrLight: false }));
    out.push(explainText(topic, { sessions: 4, visitsAt: T + HOUR, attempt: { n: 2, max: 3 }, lateOrLight: true }));
  }
  out.push(TODAY_TITLE, NO_PLAN, FEED_TITLE, freshPill(2), todaySummary(plan, true), todaySummary(plan, false), approvalsNote(plan) ?? '');
  for (const p of statuses.map((s) => s.plan).filter((x): x is PlanProjection => x != null)) out.push(todayNext(p, T));
  out.push(todayNext({ ...plan, day: { ...plan.day, dayOff: true } }, T), todayNext({ ...plan, now: { sessionIdx: 0, nextAt: null, closesAt: T + HOUR } }, T));
  out.push(todayNext({ ...plan, totals: { ...plan.totals, remaining: 0 } }, T), todayNext({ ...plan, day: { ...plan.day, light: true } }, T));
  for (const s of plan.sessions) out.push(sessionTip(s));
  out.push(RESULTS.heroLabel, RESULTS.heroTip(T), RESULTS.followers(1), RESULTS.followers(1284), RESULTS.checked(T - MIN, T));
  out.push(RESULTS.checked(T - 30 * HOUR, T), RESULTS.checkingNow, RESULTS.neverSeen, RESULTS.backs(null, 4), RESULTS.backs(1, 0));
  out.push(RESULTS.updating, RESULTS.signedOut, RESULTS.loading, RESULTS.spark(7));
  out.push(GET_STARTED.title, GET_STARTED.progress(1, 3), GET_STARTED.signIn, GET_STARTED.seed, GET_STARTED.start, GET_STARTED.choose);
  out.push(FOOTER.version('3.4.1'), FOOTER.ready, FOOTER.available, FOOTER.diagnostics);
  for (const item of feedItems) {
    const face = rowFace(item);
    const say = (parts: typeof face.line): string =>
      parts.map((p) => (typeof p === 'string' ? p : p.person.username === null ? SOMEONE : `@${p.person.username}`)).join('');
    out.push(say(face.line), face.detail === null ? '' : say(face.detail));
  }
  out.push(FEED_EMPTY, sinceYouLeft('Mon 11:20 PM'));
  out.push(buttonLabel(12, false), buttonLabel(null, false), buttonLabel(12, true), BOOST_NEEDS_PLAN, PAUSED_REASON);
  for (const state of ['on', 'waiting', 'paused'] as const) out.push(bandLine(boost({ state }), T));
  const preview = { hours: 12, endsAt: T + 12 * HOUR, effectiveFrom: T, startsSessionNow: false, extraFollowsToday: 9, unfollowsWaiting: 6 };
  for (const why of ['ready', 'nothing-to-shift', 'light-day', 'quiet-hours', 'day-off', 'limit-reached-today', 'backlog', 'engine-stopped'] as const) {
    out.push(previewLine({ ...preview, why }, T + HOUR, 30));
  }
  out.push(previewLine({ ...preview, why: 'ready', extraFollowsToday: 0, startsSessionNow: true }, T + HOUR, 30));
  out.push(previewLine({ ...preview, why: 'ready', unfollowsWaiting: 0 }, T + HOUR, 30));
  out.push(...Object.values(BOOST_COPY.unavailable), BOOST_COPY.control.ended, BOOST_COPY.control.changeLength, BOOST_COPY.explain);
  for (const face of Object.values(PRIMARY_FACE)) out.push(face.label);
  out.push(...Object.values(SECONDARY_LABEL), ...Object.values(PILL), STOP_TOAST, UNDO);
  out.push(UPDATE_TOAST.ready('3.4.1'), UPDATE_TOAST.available('3.4.1'));
  for (const op of ops) out.push(liveOpText(op));
  return out.filter((s) => s !== '');
}

/** B.10's never-use list, the neutral-naming list, and the retired synonyms of the one word per concept. */
const BANNED = [
  /\bbots?\b/i, /\bhuman/i, /\bnatural/i, /\bemulat/i, /\bmimic/i, /\bstealth/i, /\bdetect/i, /\bspoof/i,
  /\bautomat(ion|ed)\b/i, /\baggressive/i, /\bjitter/i, /\bchurn/i, /\bceiling/i, /\bvelocity/i, /\bban(ned)?\b/i,
  /\bflagged\b/i, /\bblock(ed|s)?\b/i, /\bclean[ -]?up/i, /\bcleaning up\b/i, /\bwhitelist/i, /\bsteady\b/i,
];

describe('law L-COPY over every sentence the live column can say', () => {
  const sentences = everySentence();

  it('the fixtures reach a broad deck', () => {
    expect(new Set(sentences).size).toBeGreaterThan(200);
  });

  it('uses no banned word, and says Prune for the cleanup feature', () => {
    const hits = sentences.flatMap((s) => BANNED.filter((re) => re.test(s)).map((re) => `${re} in "${s}"`));
    expect(hits).toEqual([]);
  });

  it('never shows a raw key, an unfilled slot or a missing value', () => {
    // A key reads as a key when it is compound ('seed-missing', 'sentinel:ok'); 'offline' is also a word.
    const keys = [...KNOWN_BLOCK_KEYS, ...KNOWN_REFUSALS, 'a-key-epo-does-not-know', 'a-refusal-epo-does-not-know']
      .filter((k) => /[-:]/.test(k));
    const raw = sentences.filter(
      (s) => keys.some((k) => s.includes(k)) || /\{\w+\}/.test(s) || /\b(undefined|null|NaN)\b|\[object/.test(s),
    );
    expect(raw).toEqual([]);
  });

  it('keeps every headline to 15 characters', () => {
    const long = ALL_KINDS.map((k) => postureHeadline(k)).filter((h) => h.length > 15);
    expect(long).toEqual([]);
    expect(headlineOf(posture('cleaning-up'), idlePruneStatus({ state: 'paused' })).length).toBeLessThanOrEqual(15);
  });

  it('an unknown attention reads neutrally and shows its key only on the code line', () => {
    const unknown = classifyBlock('a-key-epo-does-not-know');
    expect(attentionSentence(unknown, { maxAttempts: null, unconfirmed: null })).toBe(UNKNOWN_ATTENTION);
    expect(attentionCode(unknown)).toBe('Code: a-key-epo-does-not-know');
  });
});

/** The copy modules whose string literals are copy (or a template of it). */
const DECKS = [
  'src/renderer/sidebar/copy/posture-copy.ts', 'src/renderer/sidebar/copy/attention-copy.ts',
  'src/renderer/sidebar/copy/refusal-copy.ts', 'src/renderer/sidebar/copy/explain-copy.ts',
  'src/renderer/sidebar/copy/feed-copy.ts', 'src/renderer/sidebar/copy/zone-copy.ts', 'src/renderer/sidebar/boost-copy.ts',
  'src/renderer/copy/boost.ts', 'src/shared/live-op.ts', 'src/renderer/hooks/useUpdateToasts.ts',
];

/** An swc AST node, walked generically. */
type Node = { readonly type?: string; readonly [k: string]: unknown };

/** Expressions that only carry a type: their value is walked, their type is not. */
const TYPED = new Set(['TsAsExpression', 'TsConstAssertion', 'TsSatisfiesExpression', 'TsNonNullExpression']);

/** Every string or template piece in a source that is not an import path, a type or a property key. */
function literals(source: string): string[] {
  const ast = parseSync(source, { syntax: 'typescript', tsx: true }) as unknown as Node;
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const n = node as Node;
    if (n.type !== undefined && TYPED.has(n.type)) {
      visit(n.expression);
      return;
    }
    if (n.type === 'ImportDeclaration' || n.type === 'ExportAllDeclaration' || n.type?.startsWith('Ts')) return;
    if (n.type === 'KeyValueProperty') {
      visit(n.value);
      return;
    }
    if (n.type === 'StringLiteral') out.push(String(n.value));
    if (n.type === 'TemplateElement') out.push(String(n.cooked ?? n.raw));
    for (const [k, v] of Object.entries(n)) if (k !== 'span') visit(v);
  };
  visit(ast);
  return out;
}

const deck = (file: string): string[] => literals(fs.readFileSync(path.join(ROOT, file), 'utf8'));

describe('law L-COPY in the decks themselves', () => {
  it('the scan reads copy inside typed objects and templates, and skips keys, types and imports', () => {
    const template = ['const f = (n: number) => `Next in 4 ', '$', '{n}`;'].join('');
    const found = literals(
      `import { x } from './a1';\ntype K = 'k2';\nconst A = { 'key-3': 'Wait 5 minutes' } as const;\n${template}`,
    );
    expect(found).toEqual(['Wait 5 minutes', 'Next in 4 ', '']);
  });

  it.each(DECKS)('%s holds no literal number: counts and times come from projections', (file) => {
    const strings = deck(file);
    expect(strings.length).toBeGreaterThan(3);
    expect(strings.filter((s) => /\d/.test(s))).toEqual([]);
  });
});
