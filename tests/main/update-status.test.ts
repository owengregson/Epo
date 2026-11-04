/**
 * The updater's truth (spec §13): it starts `unchecked`, says "up to date" (`idle`) only after a check that found
 * nothing, reads a missing feed or an offline check as `unavailable` (never up to date), and stamps `checkedAt`
 * on every completed check; a download's own progress and failure never pose as a check.
 */

import { initialStatus, nextUpdateStatus, resolveAppVersion, type UpdateEvent } from '@/main/update-core';
import type { UpdateStatus } from '@/shared/update-status';
import { version as packageVersion } from '../../package.json';

const T = 1_800_000_000_000;
const run = (events: UpdateEvent[], start = initialStatus('notify', '3.2.0')): UpdateStatus =>
  events.reduce((s, e, i) => nextUpdateStatus(s, e, T + i), start);

test('before any check the state is unchecked, with no check time', () => {
  expect(initialStatus('notify', '3.2.0')).toEqual({
    state: 'unchecked', mode: 'notify', current: '3.2.0', version: null, percent: null, error: null, checkedAt: null,
  });
});

test('up to date only after a check that found nothing', () => {
  expect(run([{ kind: 'checking' }])).toMatchObject({ state: 'checking', checkedAt: null });
  expect(run([{ kind: 'checking' }, { kind: 'none' }])).toMatchObject({ state: 'idle', version: null, checkedAt: T + 1 });
});

test('no feed, no release or no network reads as unavailable, stamped, never as up to date', () => {
  for (const message of ['HttpError: 404 Not Found', 'getaddrinfo ENOTFOUND api.github.com', 'net::ERR_INTERNET_DISCONNECTED']) {
    expect(run([{ kind: 'checking' }, { kind: 'error', message }])).toMatchObject({ state: 'unavailable', error: null, checkedAt: T + 1 });
  }
});

test('a real failure of a check is an error with its message, stamped', () => {
  expect(run([{ kind: 'checking' }, { kind: 'error', message: 'Cannot parse update info' }]))
    .toMatchObject({ state: 'error', error: 'Cannot parse update info', checkedAt: T + 1 });
});

test('an offered update is stamped; the download keeps the check time and its own failure is always an error', () => {
  const offered = run([{ kind: 'checking' }, { kind: 'available', version: '3.3.0' }]);
  expect(offered).toMatchObject({ state: 'available', version: '3.3.0', checkedAt: T + 1 });
  const downloading = nextUpdateStatus(offered, { kind: 'progress', percent: 41.6 }, T + 9);
  expect(downloading).toMatchObject({ state: 'downloading', percent: 42, checkedAt: T + 1 });
  expect(nextUpdateStatus(downloading, { kind: 'downloaded', version: '3.3.0' }, T + 10))
    .toMatchObject({ state: 'ready', version: '3.3.0', percent: 100, error: null, checkedAt: T + 1 });
  expect(nextUpdateStatus(downloading, { kind: 'error', message: 'net::ERR_CONNECTION_RESET' }, T + 10))
    .toMatchObject({ state: 'error', error: 'net::ERR_CONNECTION_RESET', percent: null, checkedAt: T + 1 });
});

test('a later check moves the check time forward; nothing else ever says up to date', () => {
  const first = run([{ kind: 'checking' }, { kind: 'none' }]);
  const again = nextUpdateStatus(nextUpdateStatus(first, { kind: 'checking' }, T + 50), { kind: 'none' }, T + 60);
  expect(again.checkedAt).toBe(T + 60);
  const events: UpdateEvent[] = [{ kind: 'checking' }, { kind: 'progress', percent: 5 }, { kind: 'downloaded', version: '1' },
    { kind: 'error', message: '404' }, { kind: 'available', version: '2' }];
  for (const e of events) {
    expect(nextUpdateStatus(initialStatus('full', '1'), e, T).state).not.toBe('idle');
  }
});


test('a direct-script development launch reports Epo’s manifest version instead of Electron’s version', () => {
  expect(initialStatus('off', resolveAppVersion(false, '44.1.1')).current).toBe(packageVersion);
});

test('a branded default-runtime launch reports Epo even when Electron classifies the executable as packaged', () => {
  expect(initialStatus('off', resolveAppVersion(true, '44.1.1', true)).current).toBe(packageVersion);
});

test('a packaged install preserves its installed app version even when the source manifest differs', () => {
  expect(initialStatus('notify', resolveAppVersion(true, '3.1.2')).current).toBe('3.1.2');
});
