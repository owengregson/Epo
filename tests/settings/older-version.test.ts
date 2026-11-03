/**
 * Edits an older build made after the migration (spec §6.10, §16.4): the v1 file's `{mtimeMs, sha256}` shows
 * the change, and only additions to the two protection lists are offered back; a removal made there never applies.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_DOC, type SettingsDocV2 } from '@/settings/doc';
import { olderVersionOffer, readChangedV1 } from '@/settings/older-version';
import { SETTINGS_FILES as F } from '@/settings/persist';
import { setLevel, setSink } from '@/utils/logger';
import { memoryFs } from '../kit/settings';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const v1Text = (whitelist: unknown[], words: unknown[]): string =>
  JSON.stringify({ pruneWhitelist: whitelist, pruneBioFilterWords: words });
const MIGRATED = v1Text(['alice', 'bob'], ['art']);
const READ_AT_5 = { mtimeMs: 5, sha256: sha(MIGRATED) };

function docWith(fromV1: { mtimeMs: number; sha256: string } | null): SettingsDocV2 {
  const account = (username: string) =>
    ({ pk: null, username, linkedAt: null, formerUsernames: [], addedAt: 1, source: 'migrated', valid: true }) as const;
  return {
    ...DEFAULT_DOC,
    protection: { ...DEFAULT_DOC.protection, accounts: ['alice', 'bob'].map(account), words: [{ text: 'art', addedAt: 1 }] },
    migration: { at: 1, fromV1, notes: [], bookkeeping: null },
  };
}

test('an unchanged file, a touched file with the same bytes, a missing file or no migration record offer nothing', () => {
  expect(readChangedV1(memoryFs({ [F.v1]: MIGRATED }, 5).fs, '/u', docWith(READ_AT_5).migration)).toBeNull();
  const touched = memoryFs({ [F.v1]: MIGRATED }, 6);
  expect(readChangedV1(touched.fs, '/u', docWith(READ_AT_5).migration)).toBeNull();
  expect(readChangedV1(touched.fs, '/u', docWith(null).migration)).toBeNull();
  expect(readChangedV1(touched.fs, '/u', null)).toBeNull();
  expect(readChangedV1(memoryFs({}, 6).fs, '/u', docWith(READ_AT_5).migration)).toBeNull();
});

test('only additions return: new handles and words, never what the older build removed', () => {
  // `bob` was removed there; `ART` folds to the word the document holds; a non-string item is skipped.
  const changed = v1Text(['alice', '@Carol', 'dave', 42], ['ART', 'travel']);
  const doc = docWith(READ_AT_5);
  const v1 = readChangedV1(memoryFs({ [F.v1]: changed }, 6).fs, '/u', doc.migration);
  expect(v1).toMatchObject({ from: { mtimeMs: 6, sha256: sha(changed) } });
  const offer = olderVersionOffer(doc, v1, 9);
  expect(offer?.from).toEqual({ mtimeMs: 6, sha256: sha(changed) });
  expect(offer?.accounts.map((a) => [a.username, a.source, a.addedAt])).toEqual([['carol', 'older-version', 9], ['dave', 'older-version', 9]]);
  expect(offer?.words.map((w) => w.text)).toEqual(['travel']);
});

test('nothing new, or a file the document already read, offers nothing', () => {
  const removalsOnly = v1Text(['alice'], []);
  const doc = docWith(READ_AT_5);
  expect(olderVersionOffer(doc, readChangedV1(memoryFs({ [F.v1]: removalsOnly }, 6).fs, '/u', doc.migration), 9)).toBeNull();
  const added = v1Text(['alice', 'bob', 'carol'], ['art']);
  const read = readChangedV1(memoryFs({ [F.v1]: added }, 6).fs, '/u', doc.migration);
  expect(olderVersionOffer(doc, read, 9)?.accounts).toHaveLength(1);
  expect(olderVersionOffer(docWith({ mtimeMs: 6, sha256: sha(added) }), read, 9)).toBeNull();
  expect(olderVersionOffer(doc, null, 9)).toBeNull();
});

test('an unreadable file offers nothing and says why', () => {
  const lines: string[] = [];
  setLevel('warn');
  setSink((level, message) => lines.push(`${level} ${message}`));
  jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(readChangedV1(memoryFs({ [F.v1]: '{not json' }, 6).fs, '/u', docWith(READ_AT_5).migration)).toBeNull();
    expect(readChangedV1(memoryFs({ [F.v1]: '"text"' }, 6).fs, '/u', docWith(READ_AT_5).migration)).toBeNull();
  } finally {
    setSink(null);
    setLevel('error');
    jest.restoreAllMocks();
  }
  expect(lines).toEqual([expect.stringMatching(/^warn .*unreadable/), expect.stringMatching(/^warn .*unreadable/)]);
});
