/**
 * STORE_POLICY holds today's store bounds exactly (Phase F moves, never retunes),
 * every entry carries its one-line guard comment, and the object is the shape the
 * store reads, so main injects it as is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MS_PER_DAY } from '@/kernel';
import { STORE_POLICY } from '@/kernel/store-policy';
import type { StorePolicy } from '@/store/types';

test('the values are the literals the store carried before the move', () => {
  const injected: StorePolicy = STORE_POLICY;
  expect(injected).toEqual({
    retentionMs: 90 * MS_PER_DAY,
    spans: { ringRows: 50_000, inlineEvents: 32, trimEvery: 512, listLimit: 100 },
  });
});

test('every leaf entry sits under a one-line guard comment', () => {
  const lines = readFileSync(join(__dirname, '../../src/kernel/store-policy.ts'), 'utf8').split('\n');
  const leaves = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s+\w+: [^{]+,$/.test(line));
  expect(leaves.map(({ line }) => line.trim().split(':')[0])).toEqual([
    'retentionMs', 'ringRows', 'inlineEvents', 'trimEvery', 'listLimit',
  ]);
  for (const { i } of leaves) expect(lines[i - 1]).toMatch(/^\s+\/\*\* Guards: .+ \*\/$/);
});
