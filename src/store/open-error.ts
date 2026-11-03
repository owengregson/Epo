/**
 * Why the knowledge store could not open (spec §12.8 R3): the boot view carries the problem so the posture
 * names it ("This data was saved by a newer Epo…") instead of rendering stale or zero numbers.
 */

import type { BootDataProblem } from '@/shared/boot';

/** `runMigrations` refuses a database whose `user_version` is past this build's migrations. */
const FUTURE_VERSION = /newer than this build supports/;
/** SQLite's SQLITE_BUSY / SQLITE_LOCKED texts: another process (or a lingering handle) holds the file. */
const LOCKED = /database (?:table )?is locked|SQLITE_(?:BUSY|LOCKED)/i;

/** The text SQLite (or the store) put on a thrown value; node:sqlite adds `errstr` beside the message. */
const textOf = (e: unknown): string => {
  if (!(e instanceof Error)) return typeof e === 'string' ? e : '';
  const errstr = (e as { errstr?: unknown }).errstr;
  return typeof errstr === 'string' ? `${e.message} ${errstr}` : e.message;
};

export function classifyOpenError(e: unknown): BootDataProblem {
  const text = textOf(e);
  if (FUTURE_VERSION.test(text)) return 'future-version';
  if (LOCKED.test(text)) return 'locked';
  return 'unreadable';
}
