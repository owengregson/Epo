/**
 * The read pipeline's tier-1 guardrails (spec §10.9): the values Appendix D.1 lists, the walk's
 * fetch retry bound, and a one-line guard comment on every entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SURFACE_BOUNDS } from '@/kernel/surface-policy';

test('SURFACE_BOUNDS holds the Appendix D.1 values and the list walk fetch retry', () => {
  expect(SURFACE_BOUNDS).toEqual({
    searchMaxNodes: 20_000, searchMaxDepth: 12, searchMaxBytes: 4_000_000, rowMajority: 0.9,
    identityConflictMax: 0.05, fallbackCandidates: 8, sampleRows: 8, noveltyMaxDepth: 6,
    maxSignaturesPerEndpoint: 200, sampleMaxBytes: 16_384, samplesPerDay: 12, healthRetentionDays: 30,
    driftRetentionDays: 90, meterReservoir: 128, unmatchedPostsKept: 12, logHeadChars: 80, envelopeHeadChars: 256,
    requestBodyMaxBytes: 65_536, scrubCountDigits: 2, scrubCountFloor: 100, listWalkFetchRetries: 1,
    timeFloorMs: Date.UTC(2010, 0, 1),
  });
});

test('every SURFACE_BOUNDS entry carries a one-line guard comment', () => {
  const lines = fs.readFileSync(path.resolve(__dirname, '../../src/kernel/surface-policy.ts'), 'utf8').split('\n')
    .map((l) => l.trim());
  const start = lines.indexOf('export const SURFACE_BOUNDS = {');
  const end = lines.indexOf('} as const;', start);
  const unguarded = lines.slice(start + 1, end).flatMap((line, i, body) => {
    const entry = /^([A-Za-z]\w*):/.exec(line);
    const prev = body[i - 1] ?? '';
    return entry && !(prev.startsWith('/**') && prev.endsWith('*/')) ? [entry[1]] : [];
  });
  expect(start).toBeGreaterThan(-1);
  expect(unguarded).toEqual([]);
});
