/**
 * The Instagram activity clock (spec §5.13 S2b, §5.16): one clock per graph spaces the entry of every
 * Instagram operation — a profile visit, a list walk, the drawer — a drawn `dwell.visit` after the
 * previous operation ended, whichever caller issued either. Pinned here: the spacing and its draw,
 * its floor at any pace, the stop, and one rhythm shared by a visitor and a walker.
 */
import fc from 'fast-check';
import { Reader } from '@/adapter/reader';
import type { Sentinel } from '@/adapter/sentinel';
import { mulberry32 } from '@/kernel/rng';
import { REFERENCE_TEMPO, referenceTempoSource, resolve } from '@/kernel/tempo';
import { createIgActivityClock, underClock } from '@/rim/ig-activity-clock';
import { TabProfileVisitor } from '@/rim/profile-visit';
import { SpacedListPageWalker } from '@/rim/spaced-list-walker';
import type { Observation } from '@/store/types';
import { sample } from '@/timing/primitives';
import { setLevel } from '@/utils/logger';
import { FakeSentinel, FakeTab, followersBody } from '../kit/fakes';
import { fixedTempo, recordingTempo } from '../kit/tempo';

beforeAll(() => setLevel('error'));

/** Fake time: every sleep advances it and is recorded. */
function fakeTime(start = 1_000_000) {
  let t = start;
  const waits: number[] = [];
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
      t += ms;
    },
  };
}

/** The reference `dwell.visit` draw at a pinned uniform. */
const DRAWN = sample(referenceTempoSource().policy('dwell.visit'), () => 0.5);

describe('the spacing', () => {
  test('the first operation enters at once; the next waits the drawn dwell from the END of the last', async () => {
    const time = fakeTime();
    const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
    await clock.spaceEntry();
    expect(time.waits).toEqual([]);
    expect(clock.lastEndAt()).toBeNull();
    time.advance(7_000); // the operation itself
    clock.noteEnd(time.now());
    time.advance(2_000); // the caller's own time since it ended
    await clock.spaceEntry();
    expect(time.waits).toEqual([DRAWN - 2_000]);
  });

  test('an operation long after the last waits nothing', async () => {
    const time = fakeTime();
    const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
    clock.noteEnd(time.now());
    time.advance(DRAWN + 1);
    await clock.spaceEntry();
    expect(time.waits).toEqual([]);
  });

  test('the spacing follows the session tempo: a relaxed session spaces further than the reference', async () => {
    const spaced = async (pace: number): Promise<number> => {
      const time = fakeTime();
      const clock = createIgActivityClock({ tempo: fixedTempo(pace), now: time.now, sleep: time.sleep, rng: () => 0.5 });
      clock.noteEnd(time.now());
      await clock.spaceEntry();
      return time.waits[0] ?? 0;
    };
    expect(await spaced(1)).toBe(DRAWN);
    expect(await spaced(1.4)).toBeGreaterThan(DRAWN);
  });

  test("with no caller rng the draw takes the tempo's own dwell.visit stream", async () => {
    const tempo = recordingTempo();
    const time = fakeTime();
    const clock = createIgActivityClock({ tempo, now: time.now, sleep: time.sleep });
    clock.noteEnd(time.now());
    await clock.spaceEntry();
    expect(tempo.keys).toEqual(['dwell.visit']);
    expect(time.waits).toHaveLength(1);
  });

  test('an earlier end never moves the clock back', () => {
    const clock = createIgActivityClock();
    clock.noteEnd(5_000);
    clock.noteEnd(4_000);
    expect(clock.lastEndAt()).toBe(5_000);
  });

  test('a stop ends the wait: the sleep carries the driver signal', async () => {
    const ac = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const clock = createIgActivityClock({ now: () => 0, rng: () => 0.5, sleep: async (_ms, signal) => {
      seen.push(signal);
    } });
    clock.noteEnd(0);
    await clock.spaceEntry(ac.signal);
    expect(seen).toEqual([ac.signal]);
  });

  test('every entry lands at least the dwell floor after the previous end, at any pace (law)', async () => {
    const floor = resolve('dwell.visit', REFERENCE_TEMPO).floorValue;
    await fc.assert(fc.asyncProperty(
      fc.double({ min: 0.7, max: 1.45, noNaN: true }),
      fc.array(fc.record({ took: fc.nat(60_000), idle: fc.nat(40_000) }), { minLength: 2, maxLength: 12 }),
      fc.nat(),
      async (pace, ops, seed) => {
        const time = fakeTime();
        const clock = createIgActivityClock({ tempo: fixedTempo(pace), now: time.now, sleep: time.sleep,
          rng: mulberry32(seed) });
        let lastEnd: number | null = null;
        for (const op of ops) {
          await clock.spaceEntry();
          if (lastEnd !== null) expect(time.now() - lastEnd).toBeGreaterThanOrEqual(floor);
          time.advance(op.took);
          lastEnd = time.now();
          clock.noteEnd(lastEnd);
          time.advance(op.idle);
        }
      },
    ), { numRuns: 60 });
  });
});

describe('one operation under the clock', () => {
  test('its entry is spaced and its end is noted, whether it resolves or throws', async () => {
    const time = fakeTime();
    const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
    expect(await underClock(clock, time.now, undefined, async () => {
      time.advance(1_000);
      return 'read';
    })).toBe('read');
    expect(clock.lastEndAt()).toBe(time.now());
    await expect(underClock(clock, time.now, undefined, async () => {
      time.advance(3_000);
      throw new Error('tab gone');
    })).rejects.toThrow('tab gone');
    expect(time.waits).toEqual([DRAWN]);
    expect(clock.lastEndAt()).toBe(time.now());
  });
});

describe('one rhythm across callers', () => {
  /** A visitor whose page answers at once, and a one-page walk, both on `clock`; each records when it reaches Instagram. */
  function rig(time: ReturnType<typeof fakeTime>) {
    const clock = createIgActivityClock({ now: time.now, sleep: time.sleep, rng: () => 0.5 });
    const reached: Array<{ op: string; at: number }> = [];
    const visitTab = new FakeTab();
    visitTab.goto = async (u: string): Promise<void> => {
      reached.push({ op: 'visit', at: time.now() });
      visitTab.url = u;
    };
    const obs = { accountPk: '7', observedAt: 1, source: 'profile', fields: { username: 'seven' } } as Observation;
    const visitor = new TabProfileVisitor({
      tab: visitTab,
      observer: { expect: () => ({
        next: async () => ({ kind: 'seen', seen: { obs, viewer: { following: false, requested: false, followsUs: false } } }),
        dispose: () => {},
      }) },
      sentinel: { check: async () => 'ok' },
      activity: clock,
      now: time.now,
    });
    const walkTab = new FakeTab();
    walkTab.onEvaluate = () => {
      reached.push({ op: 'walk', at: time.now() });
      return { ok: true, status: 200, contentType: 'application/json', json: followersBody(['11'], '1', true) };
    };
    const walker = new SpacedListPageWalker(clock, {
      tab: walkTab, reader: new Reader(), clock: { now: time.now }, rng: () => 0.5,
      sleep: async (ms) => {
        time.advance(ms);
      },
    });
    const walk = () => walker.walkAll({ pk: 'ME', which: 'followers', maxPages: 1,
      sentinel: new FakeSentinel() as unknown as Sentinel, onObservation: () => {} });
    return { clock, reached, visitor, walk };
  }

  test('a visit, a walk and a visit: each reaches Instagram a drawn dwell after the last one ended', async () => {
    const time = fakeTime();
    const { clock, reached, visitor, walk } = rig(time);
    await visitor.visit('seven');
    const visitEnd = clock.lastEndAt();
    await walk();
    const walkEnd = clock.lastEndAt();
    await visitor.visit('seven');

    expect(reached.map((r) => r.op)).toEqual(['visit', 'walk', 'visit']);
    expect(visitEnd).not.toBeNull();
    expect(walkEnd).not.toBeNull();
    expect(reached[1]!.at - (visitEnd ?? 0)).toBe(DRAWN);
    expect(reached[2]!.at - (walkEnd ?? 0)).toBe(DRAWN);
    // The walk's own page wait ran inside it, so its end is later than its entry.
    expect(walkEnd).toBeGreaterThan(reached[1]!.at);
  });
});
