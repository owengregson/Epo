/**
 * Spans have two jobs, and a test for each: the CAUSE CHAIN ("why is it
 * parked" is a parent walk, not five correlated status fields) and the
 * MEASURED CORPUS the derived timeouts and poll intervals are fitted to.
 * Plus the ring, because an unbounded log on a per-row hot path is a leak.
 */

import type { KnowledgeStore } from '@/store/knowledge-store';
import { SpanSink } from '@/store/spans';
import { memoryStore } from '../kit/store';
import { driverOf, fakeClock, seededRng } from '../kit/store-driver';

const clock = fakeClock(1_700_000_000_000);
let s: KnowledgeStore;

beforeEach(() => {
  clock.set(1_700_000_000_000);
  s = memoryStore({ now: clock.now, rng: seededRng(7) });
});
afterEach(() => s.close());

test('a span records what it was, when it started, and how it ended', () => {
  const id = s.spans.open('effect.follow', { scope: 'app/run/tick', mode: 'growth', attrs: { pk: '7' } });
  clock.advance(1_100);
  s.spans.close(id, 'refused', 'rate-limited');
  expect(s.spans.get(id)).toMatchObject({
    id,
    name: 'effect.follow',
    scopeId: 'app/run/tick',
    mode: 'growth',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_100,
    outcome: 'refused',
    reason: 'rate-limited',
    attrs: { pk: '7' },
  });
});

test('ids sort by time, so lexicographic order IS the order things happened', () => {
  const ids = [s.spans.open('a'), s.spans.open('b')];
  clock.advance(5);
  ids.push(s.spans.open('c'));
  expect([...ids].sort()).toEqual(ids);
  expect(s.spans.recent().map((sp) => sp.name)).toEqual(['c', 'b', 'a']);
});

test('a closed span keeps its FIRST verdict — a later close does not rewrite it', () => {
  const id = s.spans.open('tick');
  s.spans.close(id, 'ok');
  s.spans.close(id, 'halted', 'actions-failing');
  expect(s.spans.get(id)).toMatchObject({ outcome: 'ok', reason: undefined });
});

test('the cause chain answers "why is it parked" with a parent walk', () => {
  const tick = s.spans.open('tick', { mode: 'growth' });
  const verdict = s.spans.open('verdict.pacing', { parent: tick });
  const effect = s.spans.open('effect.follow', { parent: verdict });
  s.spans.close(effect, 'refused', 'rate-limited');
  const recovery = s.spans.open('recovery.enter', { parent: effect });
  const hold = s.spans.open('hold', { parent: recovery, attrs: { rung: 1 } });
  s.spans.close(hold, 'parked', 'recovery-hold');

  expect(s.spans.causeChain(hold).map((sp) => sp.name)).toEqual([
    'hold',
    'recovery.enter',
    'effect.follow',
    'verdict.pacing',
    'tick',
  ]);
  expect(s.spans.causeChain(hold)[2].reason).toBe('rate-limited');
  expect(s.spans.childrenOf(tick).map((sp) => sp.name)).toEqual(['verdict.pacing']);
});

test('event() annotates a span, bounded, and counts what it had to drop', () => {
  const id = s.spans.open('walk', { attrs: { target: 't1' } });
  for (let i = 0; i < 40; i++) s.spans.event(id, { page: i });
  const attrs = s.spans.get(id)?.attrs as { target: string; events: { page: number }[]; droppedEvents: number };
  expect(attrs.target).toBe('t1');
  expect(attrs.events).toHaveLength(32);
  // The OLDEST go — the tail is what a post-mortem needs.
  expect(attrs.events[31].page).toBe(39);
  expect(attrs.droppedEvents).toBe(8);
  // Annotating a span that does not exist is a no-op, never a throw.
  expect(() => s.spans.event('NOSUCHSPAN', { x: 1 })).not.toThrow();
});

test('percentile measures a span duration — the seam every derived timeout reads', () => {
  // 100 samples, 1..100 ms, so the nearest-rank answer is exact.
  for (let i = 1; i <= 100; i++) {
    const id = s.spans.open('adapter.hydrate');
    clock.advance(i);
    s.spans.close(id, 'ok');
    clock.advance(1);
  }
  expect(s.spans.percentile('adapter.hydrate', 'duration', 0.5)).toBe(50);
  expect(s.spans.percentile('adapter.hydrate', 'duration', 0.95)).toBe(95);
  expect(s.spans.percentile('adapter.hydrate', 'duration', 0.99)).toBe(99);
  expect(s.spans.percentile('adapter.hydrate', 'duration', 1)).toBe(100);
  expect(s.spans.percentile('adapter.hydrate', 'duration', 0)).toBe(1);
});

test('percentile measures a numeric attribute too', () => {
  for (const ms of [10, 20, 30, 40]) s.spans.open('mutation', { attrs: { latencyMs: ms } });
  expect(s.spans.percentile('mutation', 'latencyMs', 0.5)).toBe(20);
  expect(s.spans.percentile('mutation', 'latencyMs', 1)).toBe(40);
});

test('percentile returns null rather than fabricating a number from nothing', () => {
  expect(s.spans.percentile('never-seen', 'duration', 0.5)).toBeNull();
  // An OPEN span has no duration yet and must not be counted as zero.
  s.spans.open('tick');
  expect(s.spans.percentile('tick', 'duration', 0.5)).toBeNull();
  expect(() => s.spans.percentile('tick', 'duration', 1.5)).toThrow(/\[0,1\]/);
});

test('percentile can be windowed, so a stale corpus never drives a live decision', () => {
  const write = (ms: number) => {
    const id = s.spans.open('nav');
    clock.advance(ms);
    s.spans.close(id, 'ok');
  };
  write(1000);
  const cutoff = clock.advance(60_000);
  write(10);
  expect(s.spans.percentile('nav', 'duration', 1)).toBe(1000);
  expect(s.spans.percentile('nav', 'duration', 1, { since: cutoff })).toBe(10);
});

test('the ring is bounded: the oldest rows go, the newest stay', () => {
  const store = memoryStore({ now: clock.now, rng: seededRng(3) });
  try {
    // A tiny ring proves the same rule the 50k default does.
    const small = new SpanSink(driverOf(store), { now: clock.now, rng: seededRng(3), retain: 10 });
    for (let i = 0; i < 25; i++) {
      small.open(`s${i}`);
      clock.advance(1);
    }
    small.trim();
    expect(small.count()).toBe(10);
    expect(small.recent({ limit: 1 })[0].name).toBe('s24');
    expect(small.recent({ limit: 100 }).map((sp) => sp.name)).not.toContain('s0');
  } finally {
    store.close();
  }
});

test('recent() filters by name and respects its limit', () => {
  for (let i = 0; i < 5; i++) {
    s.spans.open('tick');
    s.spans.open('effect.follow');
    clock.advance(1);
  }
  expect(s.spans.recent({ name: 'tick' })).toHaveLength(5);
  expect(s.spans.recent({ name: 'tick', limit: 2 })).toHaveLength(2);
  expect(s.spans.recent({ limit: 3 })).toHaveLength(3);
  expect(s.spans.count()).toBe(10);
});
