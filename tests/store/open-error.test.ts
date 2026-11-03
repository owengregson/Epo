/**
 * Why the store could not open (spec §12.8 R3, Appendix C.4): a database a newer build migrated is
 * `future-version`, a busy or locked database is `locked`, anything else is `unreadable`. The errors are the
 * real ones the store throws, never invented shapes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '@/store/driver/index';
import { classifyOpenError } from '@/store/open-error';
import { MIGRATIONS } from '@/store/schema';
import { openTestStore } from '../kit/store';

const dirs: string[] = [];
const tempFile = (name: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epo-open-error-'));
  dirs.push(dir);
  return path.join(dir, name);
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const thrownBy = (open: () => unknown): unknown => {
  try {
    open();
  } catch (e) {
    return e;
  }
  throw new Error('expected the open to throw');
};

test('a database a newer build migrated is future-version', () => {
  const file = tempFile('epo.db');
  const raw = openDatabase(file);
  raw.pragma('user_version', MIGRATIONS.length + 1);
  raw.close();
  expect(classifyOpenError(thrownBy(() => openTestStore(file)))).toBe('future-version');
});

test('a file that is not a database is unreadable', () => {
  const file = tempFile('epo.db');
  fs.writeFileSync(file, 'this is not a sqlite database, only text that fills the header page'.repeat(64));
  expect(classifyOpenError(thrownBy(() => openTestStore(file)))).toBe('unreadable');
});

test("SQLite's busy and locked errors are locked", () => {
  expect(classifyOpenError(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' }))).toBe('locked');
  expect(classifyOpenError(Object.assign(new Error('x'), { errstr: 'database table is locked' }))).toBe('locked');
});

test('anything else, thrown values included, is unreadable', () => {
  expect(classifyOpenError(new Error('disk I/O error'))).toBe('unreadable');
  expect(classifyOpenError('a string')).toBe('unreadable');
  expect(classifyOpenError(null)).toBe('unreadable');
});
