import {
  fixed,
  jittered,
  sample,
  scaled,
  sleep,
  TIMED_OUT,
  uniform,
  withTimeout,
} from '@/timing/primitives';

/** A deterministic rng that replays the given values in order. */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe('timing/primitives — DelayPolicy', () => {
  test('fixed always samples its value', () => {
    expect(sample(fixed(1234), seq(0.9))).toBe(1234);
  });

  test('a bare number passes through sample unchanged', () => {
    expect(sample(5000, seq(0.5))).toBe(5000);
  });

  test('uniform draws Math.round(min + rng * (max - min))', () => {
    expect(sample(uniform(2000, 5000), seq(0))).toBe(2000);
    expect(sample(uniform(2000, 5000), seq(1))).toBe(5000);
    expect(sample(uniform(2000, 5000), seq(0.5))).toBe(3500);
  });

  test('uniform clamps a negative min to 0 and max up to min', () => {
    expect(sample(uniform(-100, 50), seq(0))).toBe(0);
    expect(sample(uniform(4000, 1000), seq(1))).toBe(4000); // max clamped to min
  });

  test('jittered matches the rate-governor formula exactly', () => {
    // base = min + rng()*(max-min); jitter = base * (jp/100) * (rng()*2 - 1)
    // rng draws: 0.5 (base) then 1 (jitter → +jp%)
    // base = 60_000 + 0.5*(120_000-60_000) = 90_000; jitter = 90_000*0.3*1 = 27_000
    expect(sample(jittered(60_000, 120_000, 30), seq(0.5, 1))).toBe(117_000);
    // rng 0.5 then 0.5 → jitter term 0 → the pure midpoint
    expect(sample(jittered(60_000, 120_000, 30), seq(0.5, 0.5))).toBe(90_000);
  });

  test('scaled multiplies the inner sample (the prune 1/3 case: 60_000 → 20_000)', () => {
    const third = scaled(jittered(60_000, 60_000, 0), 1 / 3);
    expect(sample(third, seq(0.5, 0.5))).toBe(20_000);
  });
});

describe('timing/primitives — sleep', () => {
  test('resolves after ms without a signal', async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  test('resolves early (never rejects) when the signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
  });

  test('an already-aborted signal resolves immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(10_000, ac.signal)).resolves.toBeUndefined();
  });
});

describe('timing/primitives — withTimeout', () => {
  test('resolves the value when the promise wins', async () => {
    await expect(withTimeout(Promise.resolve('v'), 1000)).resolves.toBe('v');
  });

  test('resolves TIMED_OUT when the timeout wins', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10)).resolves.toBe(TIMED_OUT);
  });
});
