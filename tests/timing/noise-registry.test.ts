/**
 * Timing-noise layer guards (the deterministic-scheduling fix):
 *
 *  (i)   every non-exact class produces VARYING draws; the daily-boundary
 *        jitter is positive-only (never < base, never exactly base);
 *  (ii)  the per-key class registries cover exactly the engines' wait keys
 *        (compile-time via `satisfies`, runtime via the key-set assertions);
 *  (iii) grep guard — every DelayManager wait in the engines routes through
 *        the ONE noise-gating wrapper (engineWait / pruneWait), so no
 *        classified key can be invoked with a bare, un-noised number;
 *  (iv)  boundary jitter keys on the RESUME day: a just-before-midnight park
 *        and a just-after-midnight restart resume at the SAME jittered instant;
 *  (v)   different boundary keys draw DIFFERENT offsets the same morning.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ENGINE_WAIT_CLASS, type EngineWaitKey } from '@/engine/engine';
import { PRUNE_WAIT_CLASS, type PruneWaitKey } from '@/engine/prune-engine';
import { NOISE } from '@/timing/config';
import {
  boundarySeedKey,
  cadenceFactor,
  jitterBoundary,
  mulberry32,
  nextRestStride,
  noisify,
  type WaitClass,
} from '@/timing/noise';
import { type DelayPolicy, sample, uniform } from '@/timing/primitives';

const BASE_MS = 60_000;
const NON_EXACT: Exclude<WaitClass, 'exact'>[] = [
  'daily-boundary',
  'watcher-cadence',
  'retry-backoff',
  'local-beat',
  'sub-cadence',
];

describe('noise — class behavior (i)', () => {
  test('every non-exact class yields a policy whose samples vary over 1000 draws', () => {
    for (const cls of NON_EXACT) {
      const p = noisify(cls, BASE_MS, mulberry32(0xdecafbad));
      expect(typeof p).not.toBe('number');
      const draws = new Set<number>();
      for (let i = 0; i < 1000; i += 1) draws.add(sample(p as DelayPolicy, Math.random));
      expect(draws.size).toBeGreaterThan(10); // genuinely varying, not a constant
    }
  });

  test('class draws stay inside their configured bands', () => {
    const drawsOf = (cls: Exclude<WaitClass, 'exact'>): number[] => {
      const p = noisify(cls, BASE_MS, mulberry32(7)) as DelayPolicy;
      return Array.from({ length: 1000 }, () => sample(p, Math.random));
    };
    for (const v of drawsOf('retry-backoff')) {
      expect(v).toBeGreaterThanOrEqual(BASE_MS * NOISE.BACKOFF_MIN_FACTOR);
      expect(v).toBeLessThanOrEqual(BASE_MS * NOISE.BACKOFF_MAX_FACTOR);
    }
    for (const v of [...drawsOf('local-beat'), ...drawsOf('sub-cadence')]) {
      expect(v).toBeGreaterThanOrEqual(BASE_MS * NOISE.BEAT_MIN_FACTOR);
      expect(v).toBeLessThanOrEqual(BASE_MS * NOISE.BEAT_MAX_FACTOR);
    }
    for (const v of drawsOf('watcher-cadence')) {
      expect(v).toBeGreaterThanOrEqual(BASE_MS * NOISE.CADENCE_MIN_FACTOR);
      expect(v).toBeLessThanOrEqual(BASE_MS * NOISE.CADENCE_MAX_FACTOR);
    }
    for (const v of drawsOf('daily-boundary')) {
      expect(v).toBeGreaterThan(BASE_MS);
      expect(v).toBeLessThanOrEqual(BASE_MS + NOISE.DAILY_BOUNDARY_JITTER_MAX_MS);
    }
  });

  test("'exact' passes the base through untouched (number AND policy)", () => {
    expect(noisify('exact', BASE_MS, mulberry32(1))).toBe(BASE_MS);
    const policy = uniform(1, 2);
    expect(noisify('exact', policy, mulberry32(1))).toBe(policy);
  });

  test('noise policies never consume the SAMPLER rng (the seeded-stream guarantee)', () => {
    const p = noisify('local-beat', BASE_MS, mulberry32(3)) as DelayPolicy;
    let callerDraws = 0;
    const callerRng = (): number => {
      callerDraws += 1;
      return 0.5;
    };
    for (let i = 0; i < 50; i += 1) sample(p, callerRng);
    expect(callerDraws).toBe(0); // draws came from the BOUND noise rng only
  });

  test('jitterBoundary never returns < base and never exactly base (1 ms floor)', () => {
    for (let day = 0; day < 500; day += 1) {
      for (const entropy of [0, 1, 0xdeadbeef]) {
        const v = jitterBoundary(BASE_MS, `${day}|engine:active-hours-park`, entropy);
        expect(v).toBeGreaterThanOrEqual(BASE_MS + 1);
        expect(v).toBeLessThanOrEqual(BASE_MS + NOISE.DAILY_BOUNDARY_JITTER_MAX_MS);
      }
    }
  });

  test('cadenceFactor stays inside [CADENCE_MIN_FACTOR, CADENCE_MAX_FACTOR] and varies', () => {
    const rng = mulberry32(11);
    const draws = Array.from({ length: 1000 }, () => cadenceFactor(rng));
    for (const f of draws) {
      expect(f).toBeGreaterThanOrEqual(NOISE.CADENCE_MIN_FACTOR);
      expect(f).toBeLessThanOrEqual(NOISE.CADENCE_MAX_FACTOR);
    }
    expect(new Set(draws).size).toBeGreaterThan(10);
  });

  test('nextRestStride draws integers across the whole [MIN, MAX] stride band', () => {
    const rng = mulberry32(13);
    const draws = new Set<number>();
    for (let i = 0; i < 1000; i += 1) draws.add(nextRestStride(rng));
    for (const s of draws) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(NOISE.LIST_WALK_REST_EVERY_MIN);
      expect(s).toBeLessThanOrEqual(NOISE.LIST_WALK_REST_EVERY_MAX);
    }
    expect(draws.has(NOISE.LIST_WALK_REST_EVERY_MIN)).toBe(true);
    expect(draws.has(NOISE.LIST_WALK_REST_EVERY_MAX)).toBe(true);
  });
});

describe('noise — the class registries cover exactly the wait keys (ii)', () => {
  test('ENGINE_WAIT_CLASS key set === the EngineWaitKey union', () => {
    const expected: EngineWaitKey[] = [
      'engine:active-hours-park',
      'engine:daily-ceiling-park',
      'engine:session-park',
      'engine:velocity-park',
      'engine:enrich-backoff',
      'engine:prune-park',
      'engine:blocked-park',
      'engine:idle',
      'engine:transient-backoff',
      'engine:action-delay',
      'engine:refill-pacing',
      'engine:recovery-hold',
    ];
    expect(Object.keys(ENGINE_WAIT_CLASS).sort()).toEqual([...expected].sort());
  });

  test('the shipped engine classifications match the design', () => {
    expect(ENGINE_WAIT_CLASS['engine:active-hours-park']).toBe('daily-boundary');
    expect(ENGINE_WAIT_CLASS['engine:daily-ceiling-park']).toBe('daily-boundary');
    expect(ENGINE_WAIT_CLASS['engine:enrich-backoff']).toBe('retry-backoff');
    expect(ENGINE_WAIT_CLASS['engine:prune-park']).toBe('retry-backoff');
    expect(ENGINE_WAIT_CLASS['engine:blocked-park']).toBe('retry-backoff');
    expect(ENGINE_WAIT_CLASS['engine:idle']).toBe('local-beat');
    expect(ENGINE_WAIT_CLASS['engine:transient-backoff']).toBe('local-beat');
    // Already self-jittered at the call site — noising again would double-jitter.
    expect(ENGINE_WAIT_CLASS['engine:action-delay']).toBe('exact');
    expect(ENGINE_WAIT_CLASS['engine:refill-pacing']).toBe('exact');
    expect(ENGINE_WAIT_CLASS['engine:session-park']).toBe('exact');
    expect(ENGINE_WAIT_CLASS['engine:velocity-park']).toBe('exact');
    expect(ENGINE_WAIT_CLASS['engine:recovery-hold']).toBe('exact');
  });

  test('PRUNE_WAIT_CLASS key set === the PruneWaitKey union', () => {
    const expected: PruneWaitKey[] = ['prune:park', 'prune:action-delay'];
    expect(Object.keys(PRUNE_WAIT_CLASS).sort()).toEqual([...expected].sort());
    expect(PRUNE_WAIT_CLASS['prune:park']).toBe('retry-backoff');
    expect(PRUNE_WAIT_CLASS['prune:action-delay']).toBe('exact');
  });
});

describe('noise — every engine wait routes through the ONE noise gate (iii)', () => {
  const readSrc = (rel: string): string =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'src', rel), 'utf8');

  test('engine.ts touches the DelayManager only inside engineWait', () => {
    const src = readSrc('engine/engine.ts');
    expect((src.match(/this\.delays\.wait\(/g) ?? []).length).toBe(1);
  });

  test('prune-engine.ts touches the DelayManager only inside pruneWait', () => {
    const src = readSrc('engine/prune-engine.ts');
    expect((src.match(/this\.delays\.wait\(/g) ?? []).length).toBe(1);
  });

  test('no classified non-exact key is handed to the DelayManager directly', () => {
    const src = readSrc('engine/engine.ts') + readSrc('engine/prune-engine.ts');
    const nonExactKeys = [
      ...Object.entries(ENGINE_WAIT_CLASS),
      ...Object.entries(PRUNE_WAIT_CLASS),
    ]
      .filter(([, cls]) => cls !== 'exact')
      .map(([key]) => key);
    expect(nonExactKeys.length).toBeGreaterThan(0);
    for (const key of nonExactKeys) {
      // A bare-number direct wait would bypass the noise gate entirely.
      expect(src.includes(`delays.wait('${key}'`)).toBe(false);
      expect(src.includes(`delays.wait("${key}"`)).toBe(false);
    }
  });
});

describe('noise — daily-boundary seed keys on the RESUME day (iv, v)', () => {
  const ENTROPY = 0x5eed;

  test('a just-before-midnight park and a just-after-midnight restart resume at the SAME instant', () => {
    // Both parks target the same 08:00 boundary; only where "now" sits differs.
    const boundary = new Date(2026, 7, 24, 8, 0, 0, 0).getTime();
    const parkedAtA = new Date(2026, 7, 23, 23, 50, 0, 0).getTime(); // before midnight
    const parkedAtB = new Date(2026, 7, 24, 0, 10, 0, 0).getTime(); // restart after midnight
    const baseA = boundary - parkedAtA;
    const baseB = boundary - parkedAtB;
    const key = 'engine:active-hours-park';
    const resumeA =
      parkedAtA + jitterBoundary(baseA, boundarySeedKey(parkedAtA + baseA, key), ENTROPY);
    const resumeB =
      parkedAtB + jitterBoundary(baseB, boundarySeedKey(parkedAtB + baseB, key), ENTROPY);
    expect(resumeA).toBe(resumeB); // the RESUME-day key makes the wake restart-stable (§3)
    expect(resumeA).toBeGreaterThan(boundary); // and still strictly past the boundary
  });

  test('the two boundary keys draw DIFFERENT offsets the same morning', () => {
    const boundary = new Date(2026, 7, 24, 8, 0, 0, 0).getTime();
    const a = jitterBoundary(
      BASE_MS,
      boundarySeedKey(boundary, 'engine:active-hours-park'),
      ENTROPY,
    );
    const b = jitterBoundary(
      BASE_MS,
      boundarySeedKey(boundary, 'engine:daily-ceiling-park'),
      ENTROPY,
    );
    expect(a).not.toBe(b); // per-key seed component
  });

  test('consecutive days and different installs draw different offsets', () => {
    const key = 'engine:active-hours-park';
    const mon = new Date(2026, 7, 24, 8, 0, 0, 0).getTime();
    const tue = new Date(2026, 7, 25, 8, 0, 0, 0).getTime();
    const monOffset = jitterBoundary(BASE_MS, boundarySeedKey(mon, key), ENTROPY);
    const tueOffset = jitterBoundary(BASE_MS, boundarySeedKey(tue, key), ENTROPY);
    expect(monOffset).not.toBe(tueOffset); // per-day seed component
    const otherInstall = jitterBoundary(BASE_MS, boundarySeedKey(mon, key), ENTROPY + 1);
    expect(monOffset).not.toBe(otherInstall); // per-install seed component
  });
});
