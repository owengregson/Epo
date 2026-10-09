/**
 * Chronos exists to make docs/PRINCIPLES.md §3 a property of one query rather
 * than a rule every caller remembers. So the assertions that matter are about
 * TIME PASSING WITH THE APP CLOSED: an absolute deadline that a relaunch
 * serves the remainder of, and a cadence that comes back OVERDUE instead of
 * starting its wait again.
 *
 * Every clock here is fake; nothing sleeps.
 */

import type { KnowledgeStore } from '@/store/knowledge-store';
import { memoryStore } from '../kit/store';
import { fakeClock } from '../kit/store-driver';

const HOUR = 3_600_000;
const clock = fakeClock(1_000_000);
let s: KnowledgeStore;

beforeEach(() => {
  clock.set(1_000_000);
  s = memoryStore({ now: clock.now });
});
afterEach(() => s.close());

const arm = (over: Partial<Parameters<KnowledgeStore['chronos']['arm']>[0]> = {}) =>
  s.chronos.arm({ id: 'growth:hold', owner: 'app/run', kind: 'hold', reason: 'rate-limited', inMs: HOUR, ...over });

test('arm returns the ABSOLUTE deadline synchronously, so a caller can count down', () => {
  const t = arm();
  expect(t.dueAt).toBe(clock.at() + HOUR);
  expect(t.armedAt).toBe(clock.at());
  expect(t.baseMs).toBe(HOUR);
  expect(s.chronos.awaitable('growth:hold')).toBe(t.dueAt);
  expect(s.chronos.awaitable('nothing-armed')).toBeNull();
});

test('arm takes an absolute dueAt, and refuses a spec with no deadline at all', () => {
  expect(arm({ inMs: undefined, dueAt: 5_000_000 }).dueAt).toBe(5_000_000);
  expect(() =>
    s.chronos.arm({ id: 'x', owner: 'o', kind: 'deadline', reason: 'r' }),
  ).toThrow(/needs dueAt or inMs/);
});

test('arm is IDEMPOTENT by id: a re-arm replaces the schedule, never duplicates it', () => {
  arm();
  clock.advance(10 * 60_000);
  const again = arm({ inMs: 2 * HOUR });
  expect(again.dueAt).toBe(clock.at() + 2 * HOUR);
  expect(s.chronos.list()).toHaveLength(1);
});

test('due() returns everything already due, OLDEST FIRST, and nothing that is not', () => {
  arm({ id: 'a', inMs: 3 * HOUR });
  arm({ id: 'b', inMs: 1 * HOUR });
  arm({ id: 'c', inMs: 2 * HOUR });
  expect(s.chronos.due()).toEqual([]);
  clock.advance(2 * HOUR + 1);
  expect(s.chronos.due().map((t) => t.id)).toEqual(['b', 'c']);
  clock.advance(HOUR);
  expect(s.chronos.due().map((t) => t.id)).toEqual(['b', 'c', 'a']);
});

test('a hold armed before a relaunch serves the REMAINDER, never restarts', () => {
  const armed = arm({ inMs: 3 * HOUR });
  // "The app was closed for an hour": the clock moved, the row did not.
  clock.advance(HOUR);
  expect(s.chronos.due()).toEqual([]);
  const remaining = s.chronos.awaitable('growth:hold')! - clock.at();
  expect(remaining).toBe(2 * HOUR);
  expect(s.chronos.peek('growth:hold')?.dueAt).toBe(armed.dueAt);
});

test('a cadence that came due while the app was closed comes back OVERDUE', () => {
  const first = s.chronos.cadence('sweep:followback', 6 * HOUR, { owner: 'app', reason: 'sweep' });
  expect(first.overdue).toBe(false);
  expect(first.dueAt).toBe(clock.at() + 6 * HOUR);

  // It runs once, on time.
  clock.advance(6 * HOUR);
  s.chronos.complete('sweep:followback', clock.at());

  // Now the app is closed for fourteen hours. On relaunch the cadence is
  // re-declared exactly as the boot path would, and it is ALREADY due — §3.
  clock.advance(14 * HOUR);
  const afterRelaunch = s.chronos.cadence('sweep:followback', 6 * HOUR);
  expect(afterRelaunch.overdue).toBe(true);
  expect(afterRelaunch.lastRunAt).toBe(clock.at() - 14 * HOUR);
  expect(s.chronos.due().map((t) => t.id)).toEqual(['sweep:followback']);
});

test('re-declaring a cadence keeps its run history and does not slide the deadline', () => {
  s.chronos.cadence('c', 2 * HOUR, { owner: 'app', reason: 'cadence' });
  clock.advance(2 * HOUR);
  s.chronos.complete('c', clock.at());
  const ranAt = clock.at();
  clock.advance(30 * 60_000);
  // Three re-declarations in a row must all agree — a boot path may run twice.
  for (let i = 0; i < 3; i++) {
    const c = s.chronos.cadence('c', 2 * HOUR);
    expect(c.lastRunAt).toBe(ranAt);
    expect(c.dueAt).toBe(ranAt + 2 * HOUR);
  }
});

test('complete() advances a cadence from the RUN, so lateness does not compound', () => {
  s.chronos.cadence('c', HOUR, { owner: 'app', reason: 'cadence' });
  clock.advance(3 * HOUR); // ran two hours late
  const next = s.chronos.complete('c', clock.at());
  expect(next?.lastRunAt).toBe(clock.at());
  expect(next?.dueAt).toBe(clock.at() + HOUR);
  expect(next?.generation).toBe(1);
});

test('complete() SPENDS a one-shot timer — a hold does not come back', () => {
  arm();
  expect(s.chronos.complete('growth:hold', clock.at())).toBeNull();
  expect(s.chronos.peek('growth:hold')).toBeNull();
  // Completing something that was never armed is a value, not a throw.
  expect(s.chronos.complete('never-armed')).toBeNull();
});

test('cancel takes an exact id, an exact owner, or an owner PREFIX', () => {
  arm({ id: 'run:a', owner: 'app/run/growth' });
  arm({ id: 'run:b', owner: 'app/run/growth/tick' });
  arm({ id: 'other', owner: 'app/updater' });

  expect(s.chronos.cancel('run:a')).toBe(1);
  // Closing a scope cancels everything beneath it, in one call.
  expect(s.chronos.cancel('app/run')).toBe(1);
  expect(s.chronos.list().map((t) => t.id)).toEqual(['other']);
  expect(s.chronos.cancel('app/updater')).toBe(1);
  expect(s.chronos.list()).toEqual([]);
  expect(s.chronos.cancel('nothing')).toBe(0);
});

test('every field a spec carries survives a round trip, including the audit fields', () => {
  const t = s.chronos.arm({
    id: 'noisy',
    owner: 'app/run',
    kind: 'deadline',
    reason: 'session-park',
    inMs: 90 * 60_000,
    baseMs: 60 * 60_000,
    noiseClass: 'hold',
    seed: 'boundary:2026-09-02',
    overduePolicy: 'skip',
    generation: 3,
    spanId: 'SPAN1',
  });
  expect(s.chronos.peek('noisy')).toEqual(t);
  expect(t).toMatchObject({
    kind: 'deadline',
    reason: 'session-park',
    // base_ms is the PRE-noise interval, so a derivation test can audit the draw.
    baseMs: 60 * 60_000,
    noiseClass: 'hold',
    seed: 'boundary:2026-09-02',
    overduePolicy: 'skip',
    generation: 3,
    spanId: 'SPAN1',
  });
  expect(t.dueAt - t.armedAt).toBe(90 * 60_000);
});

test('timers outlive the process: a reopened database still owes the deadline', () => {
  // A `:memory:` store cannot be reopened, so this asserts the durable half
  // the file-backed migration fixtures cover: the row, not an in-flight timer.
  const armed = arm({ inMs: 5 * HOUR });
  const rows = s.chronos.list();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual(armed);
  expect(rows[0].dueAt).toBeGreaterThan(clock.at());
});
