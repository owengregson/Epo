/**
 * The plan runtime's tier-1 loop bounds (spec §5.16): derived from the display fundamental, each entry
 * with its one-line guard comment.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EMPIRICAL } from '@/kernel/fundamentals';
import { RUNTIME_POLICY } from '@/kernel/runtime-policy';

test('the idle floor is two perception frames', () => {
  expect(RUNTIME_POLICY.IDLE_FLOOR_MS).toBe(2 * EMPIRICAL.DISPLAY.perceptionMs);
});

test('every entry carries a one-line guard comment', () => {
  const lines = fs.readFileSync(path.resolve(__dirname, '../../src/kernel/runtime-policy.ts'), 'utf8').split('\n')
    .map((line) => line.trim());
  for (const key of Object.keys(RUNTIME_POLICY)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}:`));
    expect(lines[at - 1]).toMatch(/^\/\*\*.+\*\/$/);
  }
});
