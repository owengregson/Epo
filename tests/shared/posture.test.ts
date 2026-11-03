/**
 * Posture (spec §12.3) and law L-POSTURE: exactly one kind; its rule holds and
 * every earlier rule fails; `day-off` only from the plan's own day-off flag; a
 * late first open and a zero-volume light day read `done-for-today`. Headlines
 * fit a window title (≤ 15 characters) and use no banned word.
 */

import fc from 'fast-check';
import {
  derivePosture, POSTURE_RULES, type PostureInput, type PostureKind, postureHeadline,
} from '@/shared/posture';

const T = 1_000_000;
type Status = NonNullable<PostureInput['status']>;

const status = (over: Partial<Status> = {}): Status => ({
  basis: 'built', loggedIn: true, state: 'running', online: true, haltReason: null, parkReason: null,
  parkedUntil: null, nextActionAt: null, lastActionAt: null, hasStepped: true, recovery: null,
  runtime: { desired: 'running', phase: 'ready', blockedReason: null }, ...over,
});
const input = (over: Partial<PostureInput> = {}): PostureInput => ({
  boot: null, status: status(), prune: null, plan: null, catchUpRunning: false, boost: 'off', practice: false,
  liveOpInFlight: false, seedSet: true, unconfirmed: null, pending: null, ...over,
});
const plan = (over: Partial<NonNullable<PostureInput['plan']>> = {}): NonNullable<PostureInput['plan']> => ({
  totalsPlanned: 40, remaining: 10, sessionIdx: 1, nextAt: T + 60_000, dayOff: false, lateStart: false, light: false,
  ...over,
});

test('the precedence table is the spec order', () => {
  expect(POSTURE_RULES.map((r) => r.kind)).toEqual([
    'starting-up', 'data-unavailable', 'signed-out', 'needs-attention', 'sleeping', 'reconnecting', 'offline',
    'cleaning-up', 'catching-up', 'starting', 'paused', 'needs-seed', 'stopped', 'working', 'taking-a-break',
    'day-off', 'done-for-today', 'pacing', 'retrying', 'resting', 'working',
  ]);
});

const statusArb: fc.Arbitrary<Status> = fc.record({
  basis: fc.constantFrom<'built' | 'not-built'>('built', 'not-built'),
  loggedIn: fc.boolean(),
  state: fc.constantFrom<Status['state']>('idle', 'running', 'paused', 'halted'),
  online: fc.boolean(),
  haltReason: fc.option(fc.constantFrom('runtime-error', 'seed-missing'), { nil: null }),
  parkReason: fc.option(fc.constantFrom('daily-ceiling', 'session', 'velocity', 'read-budget', 'enrich-backoff'), { nil: null }),
  parkedUntil: fc.option(fc.integer({ min: T - 1000, max: T + 100_000 }), { nil: null }),
  nextActionAt: fc.option(fc.integer({ min: T - 1000, max: T + 100_000 }), { nil: null }),
  lastActionAt: fc.option(fc.integer({ min: T - 100_000, max: T }), { nil: null }),
  hasStepped: fc.boolean(),
  recovery: fc.option(fc.record({
    phase: fc.constantFrom<'holding' | 'probing'>('holding', 'probing'),
    resumeAt: fc.option(fc.integer({ min: T, max: T + 100_000 }), { nil: null }),
  }), { nil: null }),
  runtime: fc.option(fc.record({
    desired: fc.constantFrom<'stopped' | 'paused' | 'running'>('stopped', 'paused', 'running'),
    phase: fc.constantFrom<'ready' | 'suspended' | 'reconciling' | 'recovering'>('ready', 'suspended', 'reconciling', 'recovering'),
    blockedReason: fc.option(fc.constantFrom('account-changed', 'startup-failed'), { nil: null }),
  }), { nil: null }),
});
const inputArb: fc.Arbitrary<PostureInput> = fc.record({
  boot: fc.option(fc.record({
    phase: fc.constantFrom<'starting' | 'ready' | 'live'>('starting', 'ready', 'live'),
    identity: fc.constantFrom<'pending' | 'signed-in' | 'signed-out'>('pending', 'signed-in', 'signed-out'),
    data: fc.constantFrom<'pending' | 'open' | 'not-applicable' | 'unavailable'>('pending', 'open', 'not-applicable', 'unavailable'),
    startup: fc.record({
      step: fc.option(fc.constantFrom<'open-own-profile' | 'catch-up'>('open-own-profile', 'catch-up'), { nil: null }),
      startQueued: fc.boolean(), done: fc.boolean(),
    }),
  }), { nil: null }),
  status: statusArb,
  prune: fc.option(fc.record({
    state: fc.constantFrom('idle', 'scanning', 'running', 'paused', 'done'),
    nextActionAt: fc.option(fc.integer({ min: T, max: T + 50_000 }), { nil: null }),
  }), { nil: null }),
  plan: fc.option(fc.record({
    totalsPlanned: fc.integer({ min: 0, max: 60 }), remaining: fc.integer({ min: 0, max: 60 }),
    sessionIdx: fc.option(fc.integer({ min: 0, max: 5 }), { nil: null }),
    nextAt: fc.option(fc.integer({ min: T, max: T + 100_000 }), { nil: null }),
    dayOff: fc.boolean(), lateStart: fc.boolean(), light: fc.boolean(),
  }), { nil: null }),
  catchUpRunning: fc.boolean(),
  boost: fc.constantFrom<PostureInput['boost']>('off', 'on', 'waiting', 'paused'),
  practice: fc.boolean(),
  liveOpInFlight: fc.boolean(),
  seedSet: fc.boolean(),
  unconfirmed: fc.option(fc.constantFrom<'follow' | 'unfollow'>('follow', 'unfollow'), { nil: null }),
  pending: fc.option(fc.constantFrom<'start' | 'pause' | 'stop'>('start', 'pause', 'stop'), { nil: null }),
});

test('L-POSTURE: exactly one kind, its rule holds and every earlier rule fails', () => {
  fc.assert(fc.property(inputArb, (i) => {
    const s = i.status as Status;
    const p = derivePosture(i, T);
    const at = POSTURE_RULES.findIndex((r) => r.kind === p.kind && r.when(i, s));
    expect(at).toBeGreaterThanOrEqual(0);
    for (const earlier of POSTURE_RULES.slice(0, at)) expect(earlier.when(i, s)).toBe(false);
  }), { numRuns: 2000 });
});

test("L-POSTURE: day-off only from the plan's own day-off flag", () => {
  fc.assert(fc.property(inputArb, (i) => {
    if (i.plan?.dayOff !== true) expect(derivePosture(i, T).kind).not.toBe('day-off');
  }), { numRuns: 2000 });
});

test('L-POSTURE: a late first open and a zero-volume light day read done-for-today', () => {
  const late = derivePosture(input({ plan: plan({ lateStart: true, totalsPlanned: 0, remaining: 0, sessionIdx: null }) }), T);
  const light = derivePosture(input({ plan: plan({ light: true, totalsPlanned: 0, remaining: 0, sessionIdx: null }) }), T);
  for (const p of [late, light]) expect(p).toMatchObject({ kind: 'done-for-today', explain: 'done-for-today', primary: 'pause' });
  expect(derivePosture(input({ plan: plan({ dayOff: true, remaining: 0 }) }), T).kind).toBe('day-off');
});

test('every countdown runs forward, and a status not yet known reads starting-up', () => {
  fc.assert(fc.property(inputArb, (i) => {
    const c = derivePosture(i, T).countdown;
    if (c !== null) expect(c.to).toBeGreaterThan(c.from);
  }), { numRuns: 1000 });
  expect(derivePosture(input({ status: null }), T).kind).toBe('starting-up');
});

test('controls: attention, prune and growth each get their own primary and secondary', () => {
  const blocked = derivePosture(input({ status: status({ runtime: { desired: 'running', phase: 'ready', blockedReason: 'x' } }) }), T);
  expect(blocked).toMatchObject({ kind: 'needs-attention', tone: 'alert', primary: 'diagnostics', secondary: 'start' });
  expect(blocked.attention).toEqual({ key: 'unknown', raw: 'x', action: 'diagnostics', blocksSchedules: true });
  const pruning = derivePosture(input({ prune: { state: 'paused', nextActionAt: null } }), T);
  expect(pruning).toMatchObject({ kind: 'cleaning-up', driver: 'prune', primary: 'resume-cleanup', secondary: 'stop-cleanup' });
  const resting = derivePosture(input({ status: status({ parkReason: 'session', parkedUntil: T + 5_000, lastActionAt: T - 5_000 }) }), T);
  expect(resting).toMatchObject({ kind: 'resting', primary: 'pause', secondary: 'stop', explain: 'resting' });
  expect(resting.countdown).toEqual({ from: T - 5_000, to: T + 5_000, toward: 'next-session' });
  expect(derivePosture(input({ status: status({ state: 'idle' }), seedSet: false }), T).primary).toBe('set-up');
});

test('headlines fit a window title and use no banned word', () => {
  const kinds = [...new Set(POSTURE_RULES.map((r) => r.kind))] as PostureKind[];
  for (const kind of kinds) {
    const h = postureHeadline(kind);
    expect(h.length).toBeGreaterThan(0);
    expect(h.length).toBeLessThanOrEqual(15);
    expect(h).not.toMatch(/bot|human|emulat|stealth|mimic|spoof|detect|natural|whitelist|clean ?up/i);
  }
});
