/**
 * Posture (spec §12.3) and laws L-POSTURE (exactly one kind; its rule holds and every earlier rule
 * fails; `day-off` only from the plan's own day-off flag; a late first open and a zero-volume light day
 * read `done-for-today`), L-PRIMARY (each kind offers its own controls, Stop only when there is
 * something to stop) and L-COUNTDOWN (a countdown runs forward toward a real deadline of its kind).
 * Headlines fit a window title (≤ 15 characters) and use no banned word.
 */

import fc from 'fast-check';
import {
  type Countdown, derivePosture, POSTURE_RULES, type PostureInput, type PostureKind, type PrimaryControl,
  postureHeadline,
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

/** The controls each kind may offer (spec §12.3's Primary column). */
const PRIMARY_OF: Readonly<Record<PostureKind, readonly PrimaryControl[]>> = {
  'starting-up': [null], 'data-unavailable': ['diagnostics'], 'signed-out': ['sign-in'],
  'needs-attention': ['start', 'show-live', 'choose-seed', 'check-update', 'open-prune', 'diagnostics', null],
  sleeping: ['pause', null], reconnecting: ['pause'], offline: ['pause'],
  'cleaning-up': ['pause-cleanup', 'resume-cleanup'], 'catching-up': ['starting', 'pause', 'start'],
  starting: ['starting'], paused: ['resume'], 'needs-seed': ['set-up'], stopped: ['start'],
  'taking-a-break': ['pause'], 'day-off': ['pause'], 'done-for-today': ['pause'], pacing: ['pause'],
  retrying: ['pause'], resting: ['pause'], working: ['pause'],
};

test('L-PRIMARY: each kind offers its own primary; Stop only when there is something to stop', () => {
  fc.assert(fc.property(inputArb, (i) => {
    const s = i.status as Status;
    const p = derivePosture(i, T);
    expect(PRIMARY_OF[p.kind]).toContain(p.primary);
    if (p.secondary !== null) expect(p.secondary).not.toBe(p.primary);
    const stoppable = s.state === 'running' || s.state === 'paused' || i.boot?.startup.startQueued === true
      || i.pending === 'start';
    if (p.kind === 'cleaning-up') expect(p.secondary).toBe('stop-cleanup');
    else if (p.kind === 'needs-attention') expect(['start', null]).toContain(p.secondary);
    else if (p.kind === 'starting-up' || p.kind === 'data-unavailable' || p.kind === 'signed-out') expect(p.secondary).toBeNull();
    else expect(p.secondary).toBe(stoppable ? 'stop' : null);
  }), { numRuns: 2000 });
});

const TOWARD_OF: Partial<Record<PostureKind, Countdown['toward']>> = {
  working: 'next-step', 'cleaning-up': 'cleanup-step', 'taking-a-break': 'resume', pacing: 'resume',
  retrying: 'retry', resting: 'next-session', 'day-off': 'next-session', 'done-for-today': 'next-session',
};

test('L-COUNTDOWN: forward, toward a real deadline of its kind, never beside the busy ring', () => {
  fc.assert(fc.property(inputArb, (i) => {
    const s = i.status as Status;
    const p = derivePosture(i, T);
    if (p.countdown === null) return;
    expect(p.countdown.to).toBeGreaterThan(p.countdown.from);
    expect(p.countdown.toward).toBe(TOWARD_OF[p.kind]);
    const deadlines = [s.nextActionAt, s.parkedUntil, s.recovery?.resumeAt, i.plan?.nextAt, i.prune?.nextActionAt];
    expect(deadlines).toContain(p.countdown.to);
    expect(p.busy).toBe(false);
  }), { numRuns: 2000 });
});

test('a step in flight shows the step itself: the ring is busy, no stale deadline', () => {
  const p = derivePosture(input({ liveOpInFlight: true, status: status({ nextActionAt: T + 9_000, lastActionAt: T - 1_000 }) }), T);
  expect(p).toMatchObject({ kind: 'working', busy: true, countdown: null });
});

test('attention classifies by default; the unconfirmed breaker rides any kind without blocking schedules', () => {
  const halted = derivePosture(input({ status: status({ state: 'halted', haltReason: 'seed-unresolved' }) }), T);
  expect(halted).toMatchObject({ kind: 'needs-attention', primary: 'choose-seed', secondary: 'start' });
  expect(halted.attention).toMatchObject({ key: 'seed-unresolved', action: 'choose-seed', blocksSchedules: true });
  const clearing = derivePosture(input({
    status: status({ runtime: { desired: 'stopped', phase: 'ready', blockedReason: 'data-clear-in-progress' } }),
  }), T);
  expect(clearing).toMatchObject({ primary: null, secondary: null });
  const working = derivePosture(input({ unconfirmed: 'unfollow' }), T);
  expect(working.kind).toBe('working');
  expect(working.attention).toMatchObject({ key: 'actions-unconfirmed', action: 'wait', blocksSchedules: false });
});

test('a queued Start can be stopped while the startup sequence runs', () => {
  const boot = {
    phase: 'live' as const, identity: 'signed-in' as const, data: 'open' as const,
    startup: { step: 'catch-up' as const, startQueued: true, done: false },
  };
  const p = derivePosture(input({ boot, status: status({ state: 'idle' }) }), T);
  expect(p).toMatchObject({ kind: 'catching-up', primary: 'starting', secondary: 'stop' });
});

test('Boost and practice explain themselves when the posture has no topic of its own', () => {
  const run = status({ nextActionAt: T + 60_000 });
  expect(derivePosture(input({ status: run, boost: 'on' }), T)).toMatchObject({ kind: 'working', explain: 'boost' });
  expect(derivePosture(input({ status: run, practice: true }), T)).toMatchObject({ kind: 'working', explain: 'practice' });
  expect(derivePosture(input({ status: run }), T).explain).toBeNull();
  // A posture's own topic wins: resting explains the sessions, even during a Boost.
  const resting = status({ parkReason: 'session', parkedUntil: T + 60_000 });
  expect(derivePosture(input({ status: resting, boost: 'on' }), T).explain).toBe('resting');
});

test('the first-run headline is the short one', () => {
  expect(postureHeadline('needs-seed')).toBe('Get set up');
  expect(postureHeadline('data-unavailable')).toBe("Can't open data");
});
