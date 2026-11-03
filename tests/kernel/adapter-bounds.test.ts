/**
 * The Actor's tier-1 guardrails (spec §17.8): the list-dialog attempts moved out of `actor.ts`
 * unchanged, each entry with its one-line guard comment.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ADAPTER_BOUNDS } from '@/kernel/adapter-bounds';

test("the list dialog opens in at most two attempts, today's bound", () => {
  expect(ADAPTER_BOUNDS).toEqual({ OPEN_LIST_ATTEMPTS: 2 });
});

test('every entry carries a one-line guard comment', () => {
  const lines = fs.readFileSync(path.resolve(__dirname, '../../src/kernel/adapter-bounds.ts'), 'utf8').split('\n')
    .map((line) => line.trim());
  for (const key of Object.keys(ADAPTER_BOUNDS)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    expect(lines[at - 1]).toMatch(/^\/\*\*.+\*\/$/);
  }
});
