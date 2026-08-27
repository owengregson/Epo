import { initialStatus, isBenignFeedError, resolveUpdateMode } from '@/main/update-core';

/**
 * The updater's platform matrix and error classification (docs/RELEASE.md §5)
 * are load-bearing safety decisions: 'notify' on unsigned macOS and portable
 * Windows is what keeps the updater from ever starting a download it cannot
 * apply, and the benign-error set is what keeps a private repo / zero-release
 * / offline launch from painting a red error on every start.
 */
describe('update-core', () => {
  test('mode matrix: dev off, NSIS full, portable and macOS notify, linux off', () => {
    const base = { isPackaged: true, portableDir: undefined };
    expect(resolveUpdateMode({ ...base, platform: 'win32', isPackaged: false })).toBe('off');
    expect(resolveUpdateMode({ ...base, platform: 'win32' })).toBe('full');
    expect(resolveUpdateMode({ ...base, platform: 'win32', portableDir: 'C:\\Apps' })).toBe('notify');
    expect(resolveUpdateMode({ ...base, platform: 'darwin' })).toBe('notify');
    expect(resolveUpdateMode({ ...base, platform: 'linux' })).toBe('off');
  });

  test('benign feed outcomes stay quiet; real failures do not', () => {
    for (const msg of [
      'HttpError: 404 Not Found',
      'Cannot find latest release: No published versions on GitHub',
      'getaddrinfo ENOTFOUND api.github.com',
      'net::ERR_INTERNET_DISCONNECTED',
      'connect ETIMEDOUT 140.82.112.6:443',
      "ENOENT: no such file or directory, open '/Applications/Epo.app/Contents/Resources/app-update.yml'",
    ]) {
      expect(isBenignFeedError(msg)).toBe(true);
    }
    for (const msg of [
      'sha512 checksum mismatch, expected X got Y',
      'ZIP file not provided',
      'Cannot parse update info',
    ]) {
      expect(isBenignFeedError(msg)).toBe(false);
    }
  });

  test('initial status carries the mode and running version, nothing else', () => {
    expect(initialStatus('notify', '3.0.0')).toEqual({
      state: 'idle',
      mode: 'notify',
      current: '3.0.0',
      version: null,
      percent: null,
      error: null,
    });
  });
});
