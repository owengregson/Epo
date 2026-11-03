/**
 * The entropy root (spec §20.4): crypto draws are uniform on [0, 1); launch streams are seeded once
 * per process, never shared between consumers, and as uniform as the Math.random they replace.
 */
import { cryptoUniform, launchSeed, launchStream } from '@/utils/entropy';
import { memoryStore } from '../kit/store';

const WORD = 2 ** 32;
const draws = (rng: () => number, n: number): number[] => Array.from({ length: n }, () => rng());

test('a crypto draw lands in [0, 1) on the 32-bit grid', () => {
  const xs = draws(cryptoUniform, 2_000);
  expect(xs.filter((x) => !(x >= 0 && x < 1) || !Number.isInteger(x * WORD))).toEqual([]);
  expect(new Set(xs).size).toBeGreaterThan(1_990);
});

test('the launch seed is one 32-bit draw per process', () => {
  const seed = launchSeed();
  expect(Number.isInteger(seed) && seed >= 0 && seed < WORD).toBe(true);
  expect(launchSeed()).toBe(seed);
});

test('two consumers never share a sequence, under one label or two', () => {
  const first = draws(launchStream('test/same'), 16);
  expect(draws(launchStream('test/same'), 16)).not.toEqual(first);
  expect(draws(launchStream('test/other'), 16)).not.toEqual(first);
});

test('a launch stream is uniform: mean, variance and deciles', () => {
  const xs = draws(launchStream('test/uniform'), 20_000);
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
  // Six standard errors each, and a chi-square far past p = 1e-9 for nine degrees of freedom.
  expect(Math.abs(mean - 0.5)).toBeLessThan(0.0125);
  expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.004);
  const bins = new Array<number>(10).fill(0);
  for (const x of xs) bins[Math.floor(x * 10)] += 1;
  const chiSquare = bins.reduce((s, n) => s + (n - 2_000) ** 2 / 2_000, 0);
  expect(chiSquare).toBeLessThan(60);
});

test('the store owns no randomness: a draw without an injected rng refuses loudly', () => {
  const store = memoryStore();
  try {
    expect(() => store.installEntropy()).toThrow('store: no rng injected');
    expect(() => store.spans.open('tick')).toThrow('store: no rng injected');
  } finally {
    store.close();
  }
});
