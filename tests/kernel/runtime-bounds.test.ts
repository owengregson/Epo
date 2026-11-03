/**
 * RUNTIME_BOUNDS (spec §17.8–§17.9, the rows marked BL): the literals the four main services, RuntimeHealth,
 * the userData rename and the origin settle carried, moved and never retuned; their orderings hold; every entry
 * carries its one-line guard comment.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MS_PER_MINUTE, MS_PER_SECOND } from '@/kernel';
import { RUNTIME_BOUNDS } from '@/kernel/runtime-bounds';
import { RECOVERY } from '@/timing/config';

const KIB = 1024;

test('the values are the literals the services carried before the move', () => {
  expect(RUNTIME_BOUNDS).toEqual({
    REPAIR_LIMIT: 3,
    REPAIR_WINDOW_MS: 60 * MS_PER_MINUTE,
    INCIDENTS_KEPT: 50,
    DASHBOARD_LOAD_MS: 30 * MS_PER_SECOND,
    DASHBOARD_RELOADS: 3,
    DASHBOARD_RELOAD_WINDOW_MS: 10 * MS_PER_MINUTE,
    DASHBOARD_RELOAD_STEP_MS: MS_PER_SECOND,
    LOG_MAX_BYTES: 2 * KIB * KIB,
    LOG_FILES: 4,
    LOG_LINE_BYTES: 32 * KIB,
    LOG_MESSAGE_CHARS: 2_000,
    LOG_PENDING_BYTES: 256 * KIB,
    LOG_FLUSH_MS: MS_PER_SECOND,
    STARTUP_CLEANUP_MS: 15 * MS_PER_SECOND,
    STARTUP_LOG_DRAIN_MS: 2 * MS_PER_SECOND,
    HEALTH_ERROR_CHARS: 2_000,
    HEALTH_ERROR_STREAK: 5,
    ORIGIN_SETTLE_MS: 2 * MS_PER_SECOND,
    USERDATA_RENAME_RETRIES: 5,
    USERDATA_RENAME_RETRY_MS: 400,
    PROFILE_LAND_CLICK_ATTEMPTS: 2,
  });
});

test('repeated watchdog repairs cannot age out before the repair budget exhausts', () => {
  expect(RUNTIME_BOUNDS.REPAIR_WINDOW_MS).toBeGreaterThan(RUNTIME_BOUNDS.REPAIR_LIMIT * RECOVERY.STEP_WATCHDOG_MS);
});

test('a cut line fits the pending queue, and the queue fits one log generation', () => {
  expect(RUNTIME_BOUNDS.LOG_LINE_BYTES).toBeLessThan(RUNTIME_BOUNDS.LOG_PENDING_BYTES);
  expect(RUNTIME_BOUNDS.LOG_PENDING_BYTES).toBeLessThan(RUNTIME_BOUNDS.LOG_MAX_BYTES);
  expect(RUNTIME_BOUNDS.LOG_MESSAGE_CHARS).toBeLessThan(RUNTIME_BOUNDS.LOG_LINE_BYTES);
});

test('a failed startup drains its log inside the cleanup bound', () => {
  expect(RUNTIME_BOUNDS.STARTUP_LOG_DRAIN_MS).toBeLessThan(RUNTIME_BOUNDS.STARTUP_CLEANUP_MS);
});

test('the reloads a window allows all fit inside it', () => {
  const backoff = (RUNTIME_BOUNDS.DASHBOARD_RELOADS * (RUNTIME_BOUNDS.DASHBOARD_RELOADS + 1) / 2)
    * RUNTIME_BOUNDS.DASHBOARD_RELOAD_STEP_MS;
  expect(backoff + RUNTIME_BOUNDS.DASHBOARD_RELOADS * RUNTIME_BOUNDS.DASHBOARD_LOAD_MS)
    .toBeLessThan(RUNTIME_BOUNDS.DASHBOARD_RELOAD_WINDOW_MS);
});

test('every entry sits under a one-line guard comment', () => {
  const lines = readFileSync(join(__dirname, '../../src/kernel/runtime-bounds.ts'), 'utf8').split('\n');
  const entries = lines.map((line, i) => ({ line, i })).filter(({ line }) => /^ {2}[A-Z_]+: .+,$/.test(line));
  expect(entries.map(({ line }) => line.trim().split(':')[0])).toEqual(Object.keys(RUNTIME_BOUNDS));
  for (const { i } of entries) expect(lines[i - 1]).toMatch(/^ {2}\/\*\* Guards: .+ \*\/$/);
});
