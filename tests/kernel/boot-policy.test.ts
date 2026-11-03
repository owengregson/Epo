/**
 * BOOT (spec §12.8, Appendix C.2): the launch deadlines keep their order, every derived value equals its
 * formula over the fundamentals, every entry carries its one-line guard comment, and the veil's fade is the one
 * the veil page animates.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOT } from '@/kernel/boot-policy';
import { EMPIRICAL } from '@/kernel/fundamentals';

const { frameMs, perceptionMs } = EMPIRICAL.DISPLAY;

test('the deadlines advance: show fallback < data < Instagram ready < settle', () => {
  expect(BOOT.SHOW_FALLBACK_MS).toBeLessThan(BOOT.DATA_DEADLINE_MS);
  expect(BOOT.DATA_DEADLINE_MS).toBeLessThan(BOOT.IG_READY_DEADLINE_MS);
  expect(BOOT.IG_READY_DEADLINE_MS).toBeLessThan(BOOT.SETTLE_DEADLINE_MS);
});

test('the Instagram deadline is p95 home hydration plus two median navigations', () => {
  expect(BOOT.IG_READY_DEADLINE_MS).toBe(EMPIRICAL.LATENCY.hydration.p95 + 2 * EMPIRICAL.LATENCY.nav.p50);
});

test('the curtain and the veil derive from the display fundamentals', () => {
  expect(BOOT.CURTAIN_PAINT_MAX_MS).toBe(Math.ceil(6 * frameMs));
  expect(BOOT.CURTAIN_PAINT_MAX_MS).toBeGreaterThanOrEqual(2 * frameMs);
  expect(BOOT.CURTAIN_FADE_MS).toBe(3 * perceptionMs);
  expect(BOOT.ACTIVITY_NULL_HOLD_MS).toBe(2 * perceptionMs);
  expect(BOOT.VEIL_FADE_MS).toBe(4 * perceptionMs);
  expect(BOOT.VEIL_CURSOR_FLUSH_MS).toBe(Math.floor(frameMs));
});

test("the veil's fade is the opacity transition veil.html animates", () => {
  const html = readFileSync(join(__dirname, '../../src/main/overlay/veil.html'), 'utf8');
  const veil = /\.veil \{[^}]*transition: opacity ([\d.]+)s ease;/.exec(html);
  expect(veil).not.toBeNull();
  expect(Number(veil?.[1]) * 1000).toBe(BOOT.VEIL_FADE_MS);
});

test('every entry sits under a one-line guard comment', () => {
  const lines = readFileSync(join(__dirname, '../../src/kernel/boot-policy.ts'), 'utf8').split('\n');
  const entries = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^ {2}[A-Z_]+: .+,$/.test(line));
  expect(entries.map(({ line }) => line.trim().split(':')[0])).toEqual(Object.keys(BOOT));
  for (const { i } of entries) expect(lines[i - 1]).toMatch(/^ {2}\/\*\* Guards: .+ \*\/$/);
});
