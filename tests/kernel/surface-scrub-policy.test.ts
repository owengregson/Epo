/**
 * SURFACE_BOUNDS holds spec §10.9's values exactly and SCRUB_POLICY's synthetic ranges never overlap each other
 * or a real value's range; every entry of both tables carries its one-line guard comment.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCRUB_POLICY } from '@/kernel/scrub-policy';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';

test('SURFACE_BOUNDS carry the values of spec §10.9', () => {
  expect(SURFACE_BOUNDS).toMatchObject({
    searchMaxNodes: 20_000, searchMaxDepth: 12, searchMaxBytes: 4_000_000, rowMajority: 0.9, identityConflictMax: 0.05,
    fallbackCandidates: 8, sampleRows: 8, noveltyMaxDepth: 6, maxSignaturesPerEndpoint: 200, sampleMaxBytes: 16_384,
    samplesPerDay: 12, healthRetentionDays: 30, driftRetentionDays: 90, meterReservoir: 128, unmatchedPostsKept: 12,
    logHeadChars: 80, envelopeHeadChars: 256, requestBodyMaxBytes: 65_536, scrubCountDigits: 2, scrubCountFloor: 100,
  });
});

test('the synthetic id range and the synthetic time window cannot overlap, and both sit away from real values', () => {
  const { syntheticPkBase: pk, syntheticPkSpan: pkSpan, syntheticTimeBase: t, syntheticTimeSpan: tSpan } = SCRUB_POLICY;
  expect(String(pk).length).not.toBe(String(t).length);
  expect(String(pk + pkSpan - 1).length).toBe(String(pk).length);
  expect(String(t + tSpan - 1).length).toBe(String(t).length);
  // A shifted time stays in the past of every replay clock (epoch seconds, before 2025).
  expect(t + tSpan).toBeLessThan(Date.UTC(2025, 0, 1) / 1000);
  expect(SCRUB_POLICY.keptNumberMax).toBeLessThan(t);
});

test.each(['surface-policy.ts', 'scrub-policy.ts'])('%s: every entry sits under a one-line guard comment', (file) => {
  const lines = readFileSync(join(__dirname, '../../src/kernel', file), 'utf8').split('\n');
  const entries = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^ {2}\w+: [^{]+,$/.test(line));
  expect(entries.length).toBeGreaterThan(0);
  for (const { i } of entries) expect(lines[i - 1]).toMatch(/^ {2}\/\*\* .+ \*\/$/);
});
